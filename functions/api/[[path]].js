const GH = 'https://api.github.com';
const CB = 'https://codeberg.org/api/v1';

function jsonResponse(data, ttl) {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + ttl,
    },
  });
}

async function gh(path, env) {
  const res = await fetch(GH + path, {
    headers: {
      'authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'yurivski-portfolio',
    },
  });
  if (!res.ok) {
    const err = new Error('github ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function ghGraphql(query, variables, env) {
  const res = await fetch(GH + '/graphql', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': 'yurivski-portfolio',
    },
    body: JSON.stringify({ query: query, variables: variables || {} }),
  });
  if (!res.ok) {
    const err = new Error('github graphql ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getContributionsTotal(user, env) {
  try {
    const q = 'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions}}}}';
    const data = await ghGraphql(q, { login: user }, env);
    const total = data && data.data && data.data.user
      && data.data.user.contributionsCollection
      && data.data.user.contributionsCollection.contributionCalendar
      && data.data.user.contributionsCollection.contributionCalendar.totalContributions;
    return typeof total === 'number' ? total : 0;
  } catch (e) { return 0; }
}

async function getOwnedRepos(user, env) {
  const repos = await gh('/users/' + user + '/repos?per_page=100&type=owner&sort=pushed', env);
  return repos.filter(function (r) { return !r.fork && !r.archived; });
}

function normalizeGithubEvent(e) {
  const p = e.payload || {};
  const repo = e.repo ? e.repo.name : null;
  const url = repo ? ('https://github.com/' + repo) : 'https://github.com';
  let action = 'other';
  switch (e.type) {
    case 'PushEvent': action = 'push'; break;
    case 'PullRequestEvent': action = 'pr'; break;
    case 'IssuesEvent': action = 'issue'; break;
    case 'IssueCommentEvent': action = 'comment'; break;
    case 'WatchEvent': action = 'star'; break;
    case 'CreateEvent': action = 'create'; break;
    case 'ForkEvent': action = 'fork'; break;
    case 'ReleaseEvent': action = 'release'; break;
    case 'DeleteEvent': action = 'delete'; break;
    case 'PublicEvent': action = 'public'; break;
  }
  let number = null;
  if (p.pull_request && typeof p.pull_request.number !== 'undefined') number = p.pull_request.number;
  else if (p.issue && typeof p.issue.number !== 'undefined') number = p.issue.number;
  return {
    action: action,
    repo: repo,
    url: url,
    created_at: e.created_at,
    count: e.type === 'PushEvent' ? ((Array.isArray(p.commits) ? p.commits.length : 0) || p.size || p.distinct_size || 0) : 0,
    number: number,
    ref_type: p.ref_type || null,
    source: 'github',
  };
}

async function getGithubEvents(user, env) {
  try {
    const events = await gh('/users/' + user + '/events/public?per_page=30', env);
    return events.map(normalizeGithubEvent);
  } catch (e) { return []; }
}

async function cb(path, env) {
  const headers = { 'accept': 'application/json', 'user-agent': 'yurivski-portfolio' };
  if (env.CODEBERG_TOKEN) headers['authorization'] = 'token ' + env.CODEBERG_TOKEN;
  const res = await fetch(CB + path, { headers: headers });
  if (!res.ok) {
    const err = new Error('codeberg ' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function normalizeCodebergActivity(a) {
  const repo = a.repo ? a.repo.full_name : null;
  const url = repo ? ('https://codeberg.org/' + repo) : 'https://codeberg.org';
  let action = 'other';
  let count = 0;
  switch (a.op_type) {
    case 'commit_repo':
    case 'mirror_sync_push':
      action = 'push';
      try {
        const c = JSON.parse(a.content || '{}');
        count = c.Len || (c.Commits ? c.Commits.length : 0) || 0;
      } catch (e) { count = 0; }
      break;
    case 'create_pull_request':
    case 'merge_pull_request':
    case 'close_pull_request':
    case 'reopen_pull_request':
    case 'comment_pull':
      action = 'pr'; break;
    case 'create_issue':
    case 'close_issue':
    case 'reopen_issue':
      action = 'issue'; break;
    case 'comment_issue':
      action = 'comment'; break;
    case 'star_repo':
      action = 'star'; break;
    case 'create_repo':
    case 'create_branch':
    case 'push_tag':
    case 'create_tag':
      action = 'create'; break;
    case 'publish_release':
      action = 'release'; break;
    case 'fork_repo':
      action = 'fork'; break;
    case 'delete_branch':
    case 'delete_tag':
      action = 'delete'; break;
  }
  return {
    action: action,
    repo: repo,
    url: url,
    created_at: a.created,
    count: count,
    number: null,
    ref_type: null,
    source: 'codeberg',
  };
}

async function getCodebergEvents(user, env) {
  try {
    const acts = await cb('/users/' + user + '/activities/feeds?only-performed-by=true&limit=20', env);
    if (!Array.isArray(acts)) return [];
    return acts.map(normalizeCodebergActivity);
  } catch (e) { return []; }
}

async function getCodebergHealth(user, env) {
  try {
    const repo = await cb('/repos/' + user + '/argus', env);
    const branch = repo.default_branch || 'main';
    let status = 'na';
    let last = repo.pushed_at || repo.updated_at || null;
    const url = repo.html_url || ('https://codeberg.org/' + user + '/argus');
    try {
      const st = await cb('/repos/' + user + '/argus/commits/' + branch + '/status', env);
      if (st && st.state) {
        if (st.state === 'success') status = 'ok';
        else if (st.state === 'pending') status = 'warn';
        else if (st.state === 'failure' || st.state === 'error') status = 'fail';
        if (st.statuses && st.statuses.length && st.statuses[0].updated_at) {
          last = st.statuses[0].updated_at;
        }
      }
    } catch (e) {}
    return [{
      name: 'Argus',
      layer: 'codeberg · ci',
      status: status,
      last: last,
      duration_s: 0,
      url: url,
      source: 'codeberg',
    }];
  } catch (e) { return []; }
}

async function searchCount(path, env) {
  try {
    const data = await gh(path, env);
    return (data && typeof data.total_count === 'number') ? data.total_count : 0;
  } catch (e) { return 0; }
}

async function handleMetrics(user, env) {
  const profile = await gh('/users/' + user, env);
  const repos = await getOwnedRepos(user, env);

  let stars = 0;
  for (let i = 0; i < repos.length; i++) stars = stars + (repos[i].stargazers_count || 0);

  const totals = {};
  const slice = repos.slice(0, 20);
  for (let i = 0; i < slice.length; i++) {
    try {
      const langs = await gh('/repos/' + user + '/' + slice[i].name + '/languages', env);
      for (const key in langs) totals[key] = (totals[key] || 0) + langs[key];
    } catch (e) {}
  }
  let sum = 0;
  for (const k in totals) sum = sum + totals[k];
  if (sum === 0) sum = 1;

  const languages = Object.keys(totals)
    .map(function (name) { return { name: name, bytes: totals[name], pct: Math.round((totals[name] / sum) * 100) }; })
    .sort(function (a, b) { return b.bytes - a.bytes; })
    .slice(0, 8);

  const counts = await Promise.all([
    searchCount('/search/issues?q=' + encodeURIComponent('author:' + user + ' type:issue') + '&per_page=1', env),
    searchCount('/search/issues?q=' + encodeURIComponent('author:' + user + ' type:pr') + '&per_page=1', env),
    searchCount('/search/commits?q=' + encodeURIComponent('author:' + user) + '&per_page=1', env),
    getContributionsTotal(user, env),
  ]);

  return {
    stars: stars,
    repos: repos.length,
    followers: profile.followers || 0,
    following: profile.following || 0,
    issues: counts[0],
    prs: counts[1],
    commits: counts[2],
    contributions: counts[3],
    languages: languages,
  };
}

async function handleRepos(user, env) {
  const repos = await getOwnedRepos(user, env);
  return repos.map(function (r) {
    return {
      name: r.name, description: r.description, url: r.html_url, language: r.language,
      stars: r.stargazers_count || 0, forks: r.forks_count || 0, pushed_at: r.pushed_at, topics: r.topics || [],
    };
  });
}

async function handleEvents(user, env) {
  const cbUser = (env.CODEBERG_USER || user).trim();
  const both = await Promise.all([ getGithubEvents(user, env), getCodebergEvents(cbUser, env) ]);
  const merged = both[0].concat(both[1])
    .filter(function (x) { return x && x.created_at; })
    .sort(function (a, b) { return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); })
    .slice(0, 20);
  return merged;
}

async function handleActions(user, env) {
  const cbUser = (env.CODEBERG_USER || user).trim();
  const repos = await getOwnedRepos(user, env);
  const rows = [];
  const slice = repos.slice(0, 20);
  for (let i = 0; i < slice.length; i++) {
    const repo = slice[i];
    try {
      const runs = await gh('/repos/' + user + '/' + repo.name + '/actions/runs?per_page=1', env);
      if (runs.total_count > 0 && runs.workflow_runs && runs.workflow_runs.length) {
        const run = runs.workflow_runs[0];
        const start = new Date(run.run_started_at || run.created_at).getTime();
        const end = new Date(run.updated_at).getTime();
        let duration = Math.round((end - start) / 1000);
        if (isNaN(duration) || duration < 0) duration = 0;
        const status = run.conclusion === 'success' ? 'ok' : (run.conclusion == null ? 'warn' : 'fail');
        rows.push({
          name: repo.name,
          layer: 'github · ' + (run.name || 'CI'),
          status: status,
          last: run.run_started_at || run.created_at,
          duration_s: duration,
          url: run.html_url,
          source: 'github',
        });
      }
    } catch (e) {}
  }
  const cbRows = await getCodebergHealth(cbUser, env);
  return rows.concat(cbRows);
}

export async function onRequestGet(context) {
  const request = context.request;
  const env = context.env;
  const params = context.params;
  const user = (env.GITHUB_USER || 'yurivski').trim();

  if (!env.GITHUB_TOKEN) {
    return new Response(JSON.stringify({ error: 'missing GITHUB_TOKEN' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }

  const seg = Array.isArray(params.path) ? params.path[0] : params.path;

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    let data;
    let ttl;
    if (seg === 'metrics') { data = await handleMetrics(user, env); ttl = 600; }
    else if (seg === 'repos') { data = await handleRepos(user, env); ttl = 600; }
    else if (seg === 'events') { data = await handleEvents(user, env); ttl = 30; }
    else if (seg === 'actions' || seg === 'health') { data = await handleActions(user, env); ttl = 300; }
    else {
      return new Response(JSON.stringify({ error: 'unknown route' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }

    const response = jsonResponse(data, ttl);
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    const status = (err && err.status) ? err.status : 502;
    return new Response(JSON.stringify({ error: 'upstream', status: status }), {
      status: status, headers: { 'content-type': 'application/json' },
    });
  }
}