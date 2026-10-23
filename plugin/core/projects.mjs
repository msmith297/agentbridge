// Projects: shared workspaces agents join to coordinate. Each project has docs, a task board,
// key-value state, files and an activity log. Runtime-neutral like hub-core (files are stored
// as 1 MB BLOB chunks in SQLite, so no object store is needed).

const MAX_DOC_BYTES = 1_000_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done'];
export const SYSTEM_SENDER = 'agent-bridge';

export const PROJECT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS projects (
    slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    created_at INTEGER NOT NULL, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS project_docs (
    project TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (project, path))`,
  `CREATE TABLE IF NOT EXISTS project_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', assignee TEXT, created_by TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks(project, status)`,
  `CREATE TABLE IF NOT EXISTS project_task_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, author TEXT, note TEXT NOT NULL,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS project_kv (
    project TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
    updated_by TEXT, PRIMARY KEY (project, key))`,
  `CREATE TABLE IF NOT EXISTS project_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
    content_type TEXT, updated_at INTEGER NOT NULL, updated_by TEXT, UNIQUE (project, path))`,
  `CREATE TABLE IF NOT EXISTS project_file_chunks (
    file_id INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file_id, seq))`,
  `CREATE TABLE IF NOT EXISTS project_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, actor TEXT, kind TEXT NOT NULL,
    summary TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_events_project ON project_events(project, id)`,
];

export function projectSlug(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// Shared paths for docs and files: relative, no "..", forward slashes.
function cleanPath(p, what) {
  const path = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!path || path.length > 200 || path.split('/').some(seg => seg === '..' || seg === '')) {
    throw Object.assign(new Error(`invalid ${what} path "${p}"`), { status: 400 });
  }
  return path;
}

/**
 * @param db       SQL adapter (all/get/run); BLOB args are Uint8Array, BLOB results ArrayBuffer|Uint8Array
 * @param notify   (toName, text, project) => void   — system message to a peer
 */
export function createProjects({ db, now, HttpError, notify }) {
  const fail = (status, msg) => { throw new HttpError(status, msg); };

  function get(slug) {
    return db.get('SELECT * FROM projects WHERE slug = ?', projectSlug(slug));
  }

  function need(slug) {
    if (!slug) fail(400, 'not in a project: join one first (project tool, action "join"), or pass project');
    return get(slug) || fail(404, `no project "${slug}" (list them with the project tool, action "list")`);
  }

  function event(project, actor, kind, summary) {
    db.run('INSERT INTO project_events (project, actor, kind, summary, created_at) VALUES (?, ?, ?, ?, ?)',
      project, actor, kind, String(summary).slice(0, 300), now());
  }

  function create(name, description, actor) {
    const slug = projectSlug(name);
    if (!slug) fail(400, 'project name required');
    if (get(slug)) fail(409, `project "${slug}" already exists`);
    db.run('INSERT INTO projects (slug, name, description, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
      slug, String(name).trim().slice(0, 80), String(description || '').slice(0, 1000), now(), actor);
    event(slug, actor, 'project', `created project "${name}"`);
    return get(slug);
  }

  function ensure(name, actor) {
    return get(name) || create(name, '', actor);
  }

  function remove(slug) {
    const p = need(slug);
    for (const t of ['project_docs', 'project_tasks', 'project_kv', 'project_events']) db.run(`DELETE FROM ${t} WHERE project = ?`, p.slug);
    db.run('DELETE FROM project_task_notes WHERE task_id NOT IN (SELECT id FROM project_tasks)');
    db.run('DELETE FROM project_file_chunks WHERE file_id IN (SELECT id FROM project_files WHERE project = ?)', p.slug);
    db.run('DELETE FROM project_files WHERE project = ?', p.slug);
    db.run('DELETE FROM projects WHERE slug = ?', p.slug);
    return { deleted: p.slug };
  }

  function list() {
    return db.all(`SELECT p.slug, p.name, p.description, p.created_at,
      (SELECT count(*) FROM project_tasks t WHERE t.project = p.slug AND t.status != 'done') AS open_tasks,
      (SELECT count(*) FROM project_docs d WHERE d.project = p.slug) AS docs,
      (SELECT count(*) FROM project_files f WHERE f.project = p.slug) AS files,
      (SELECT max(created_at) FROM project_events e WHERE e.project = p.slug) AS last_activity
      FROM projects p ORDER BY p.name`);
  }

  // ---- docs ----

  const docs = {
    list: p => db.all('SELECT path, version, length(content) AS size, updated_at, updated_by FROM project_docs WHERE project = ? ORDER BY path', p),
    read: (p, { path }) => db.get('SELECT * FROM project_docs WHERE project = ? AND path = ?', p, cleanPath(path, 'doc'))
      || fail(404, `no doc "${path}"`),
    // Optimistic concurrency: pass the version you read as expected_version to avoid clobbering.
    write: (p, { path, content, expected_version, append }, actor) => {
      path = cleanPath(path, 'doc');
      const current = db.get('SELECT * FROM project_docs WHERE project = ? AND path = ?', p, path);
      if (expected_version != null && (current?.version ?? 0) !== Number(expected_version)) {
        fail(409, `doc "${path}" changed (now version ${current?.version ?? 0}, you expected ${expected_version}); read it again and merge`);
      }
      const text = append && current ? `${current.content}${current.content.endsWith('\n') ? '' : '\n'}${content ?? ''}` : String(content ?? '');
      if (new TextEncoder().encode(text).length > MAX_DOC_BYTES) fail(413, 'doc too large (max 1 MB); split it or use files');
      const version = (current?.version ?? 0) + 1;
      db.run(`INSERT INTO project_docs (project, path, content, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, path) DO UPDATE SET content = excluded.content, version = excluded.version,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`, p, path, text, version, now(), actor);
      event(p, actor, 'doc', `${current ? (append ? 'appended to' : 'updated') : 'created'} doc ${path} (v${version})`);
      return { path, version };
    },
    delete: (p, { path }, actor) => {
      path = cleanPath(path, 'doc');
      db.run('DELETE FROM project_docs WHERE project = ? AND path = ?', p, path);
      event(p, actor, 'doc', `deleted doc ${path}`);
      return { deleted: path };
    },
  };

  // ---- tasks ---- (addressed by task_id: in agent requests `id` identifies the agent)

  const taskRow = (p, id) => db.get('SELECT * FROM project_tasks WHERE project = ? AND id = ?', p, Number(id))
    || fail(404, `no task #${id} in this project`);

  function assigneeNotice(task, actor, verb) {
    if (task.assignee && task.assignee.toLowerCase() !== String(actor).toLowerCase()) {
      notify(task.assignee, `Task #${task.id} in project "${task.project}" ${verb} you by ${actor}: ${task.title}` +
        (task.body ? `\n\n${task.body}` : '') + '\n\nSee it with the tasks tool (action "get").', task.project);
    }
  }

  const tasks = {
    list: (p, { status, assignee }) => {
      let sql = 'SELECT id, title, status, assignee, created_by, updated_at FROM project_tasks WHERE project = ?';
      const args = [p];
      if (status) { sql += ' AND status = ?'; args.push(status); }
      else sql += " AND status != 'done'";
      if (assignee) { sql += ' AND assignee = ? COLLATE NOCASE'; args.push(assignee); }
      return db.all(sql + ' ORDER BY id', ...args);
    },
    get: (p, { task_id: id }) => ({
      ...taskRow(p, id),
      notes: db.all('SELECT author, note, created_at FROM project_task_notes WHERE task_id = ? ORDER BY id', Number(id)),
    }),
    create: (p, { title, body, assignee }, actor) => {
      if (!String(title || '').trim()) fail(400, 'task title required');
      const id = db.get(`INSERT INTO project_tasks (project, title, body, status, assignee, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?) RETURNING id`,
        p, String(title).trim().slice(0, 200), String(body || '').slice(0, 10_000), assignee || null, actor, now(), now()).id;
      const task = taskRow(p, id);
      event(p, actor, 'task', `created task #${id}: ${task.title}${assignee ? ` (assigned to ${assignee})` : ''}`);
      assigneeNotice(task, actor, 'was assigned to');
      return task;
    },
    // Atomic: only an unassigned open task (or one already yours) can be claimed.
    claim: (p, { task_id: id }, actor) => {
      const task = taskRow(p, id);
      if (task.assignee && task.assignee.toLowerCase() !== actor.toLowerCase()) fail(409, `task #${id} is already assigned to ${task.assignee}`);
      if (task.status === 'done') fail(409, `task #${id} is already done`);
      db.run(`UPDATE project_tasks SET assignee = ?, status = 'in_progress', updated_at = ? WHERE id = ?`, actor, now(), task.id);
      event(p, actor, 'task', `claimed task #${id}: ${task.title}`);
      return taskRow(p, id);
    },
    update: (p, { task_id: id, status, assignee, title, body, note }, actor) => {
      const before = taskRow(p, id);
      if (status && !TASK_STATUSES.includes(status)) fail(400, `status must be one of ${TASK_STATUSES.join(', ')}`);
      db.run(`UPDATE project_tasks SET status = ?, assignee = ?, title = ?, body = ?, updated_at = ? WHERE id = ?`,
        status || before.status,
        assignee === undefined ? before.assignee : assignee || null,
        title ? String(title).slice(0, 200) : before.title,
        body === undefined ? before.body : String(body).slice(0, 10_000),
        now(), before.id);
      if (note) db.run('INSERT INTO project_task_notes (task_id, author, note, created_at) VALUES (?, ?, ?, ?)', before.id, actor, String(note).slice(0, 5000), now());
      const after = taskRow(p, id);
      const changes = [
        status && status !== before.status ? `status → ${status}` : '',
        assignee !== undefined && after.assignee !== before.assignee ? `assignee → ${after.assignee || 'nobody'}` : '',
        note ? 'added a note' : '',
      ].filter(Boolean).join(', ');
      event(p, actor, 'task', `updated task #${id}${changes ? `: ${changes}` : ''}`);
      if (after.assignee !== before.assignee) assigneeNotice(after, actor, 'was assigned to');
      if (after.status === 'done' && before.status !== 'done' && before.created_by && before.created_by.toLowerCase() !== actor.toLowerCase()) {
        notify(before.created_by, `Task #${id} in project "${p}" was marked done by ${actor}: ${after.title}${note ? `\n\nNote: ${note}` : ''}`, p);
      }
      return after;
    },
    delete: (p, { task_id: id }, actor) => {
      const task = taskRow(p, id);
      db.run('DELETE FROM project_task_notes WHERE task_id = ?', task.id);
      db.run('DELETE FROM project_tasks WHERE id = ?', task.id);
      event(p, actor, 'task', `deleted task #${id}: ${task.title}`);
      return { deleted: task.id };
    },
  };

  // ---- key-value ----

  const kv = {
    get: (p, { key }) => (key
      ? db.get('SELECT key, value, updated_at, updated_by FROM project_kv WHERE project = ? AND key = ?', p, String(key)) || fail(404, `no key "${key}"`)
      : db.all('SELECT key, value, updated_at, updated_by FROM project_kv WHERE project = ? ORDER BY key', p)),
    set: (p, { key, value }, actor) => {
      key = String(key || '').trim();
      if (!key || key.length > 120) fail(400, 'key required (max 120 chars)');
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      if (text.length > 100_000) fail(413, 'value too large (max 100 KB); use docs or files');
      db.run(`INSERT INTO project_kv (project, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        p, key, text, now(), actor);
      event(p, actor, 'kv', `set ${key} = ${text.length > 60 ? text.slice(0, 60) + '…' : text}`);
      return { key, value: text };
    },
    delete: (p, { key }, actor) => {
      db.run('DELETE FROM project_kv WHERE project = ? AND key = ?', p, String(key));
      event(p, actor, 'kv', `deleted ${key}`);
      return { deleted: key };
    },
  };

  // ---- files ----

  const files = {
    list: p => db.all('SELECT path, size, content_type, updated_at, updated_by FROM project_files WHERE project = ? ORDER BY path', p),
    delete: (p, { path }, actor) => {
      path = cleanPath(path, 'file');
      const f = db.get('SELECT id FROM project_files WHERE project = ? AND path = ?', p, path) || fail(404, `no file "${path}"`);
      db.run('DELETE FROM project_file_chunks WHERE file_id = ?', f.id);
      db.run('DELETE FROM project_files WHERE id = ?', f.id);
      event(p, actor, 'file', `deleted file ${path}`);
      return { deleted: path };
    },
    put: (p, path, bytes, contentType, actor) => {
      path = cleanPath(path, 'file');
      if (bytes.length > MAX_FILE_BYTES) fail(413, 'file too large (max 25 MB)');
      const existing = db.get('SELECT id FROM project_files WHERE project = ? AND path = ?', p, path);
      if (existing) {
        db.run('DELETE FROM project_file_chunks WHERE file_id = ?', existing.id);
        db.run('DELETE FROM project_files WHERE id = ?', existing.id);
      }
      const id = db.get(`INSERT INTO project_files (project, path, size, content_type, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, p, path, bytes.length, contentType || 'application/octet-stream', now(), actor).id;
      for (let seq = 0, off = 0; off < bytes.length || seq === 0; seq++, off += CHUNK_BYTES) {
        db.run('INSERT INTO project_file_chunks (file_id, seq, data) VALUES (?, ?, ?)', id, seq, bytes.slice(off, off + CHUNK_BYTES));
      }
      event(p, actor, 'file', `${existing ? 'replaced' : 'uploaded'} file ${path} (${bytes.length} bytes)`);
      return { path, size: bytes.length };
    },
    get: (p, path) => {
      path = cleanPath(path, 'file');
      const f = db.get('SELECT * FROM project_files WHERE project = ? AND path = ?', p, path) || fail(404, `no file "${path}"`);
      const out = new Uint8Array(f.size);
      let off = 0;
      for (const c of db.all('SELECT data FROM project_file_chunks WHERE file_id = ? ORDER BY seq', f.id)) {
        const chunk = new Uint8Array(c.data);
        out.set(chunk, off);
        off += chunk.length;
      }
      return { file: f, bytes: out };
    },
  };

  function overview(p, members) {
    const project = need(p);
    return {
      project,
      members,
      tasks: tasks.list(project.slug, {}),
      done_tasks: db.get(`SELECT count(*) AS n FROM project_tasks WHERE project = ? AND status = 'done'`, project.slug).n,
      docs: docs.list(project.slug),
      files: files.list(project.slug),
      kv: kv.get(project.slug, {}),
      events: db.all('SELECT actor, kind, summary, created_at FROM project_events WHERE project = ? ORDER BY id DESC LIMIT 30', project.slug),
    };
  }

  // Dispatch "resource + action" requests from agents (tools) and the console alike.
  const resources = { docs, tasks, kv, files };
  function act(resource, action, project, args, actor) {
    const handler = resources[resource]?.[action];
    if (!handler || (resource === 'files' && (action === 'put' || action === 'get'))) {
      fail(400, `unknown ${resource} action "${action}"`);
    }
    return handler(need(project).slug, args, actor);
  }

  return { get, need, create, ensure, remove, list, overview, event, act, files };
}
