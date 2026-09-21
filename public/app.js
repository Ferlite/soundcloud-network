(() => {
  const $ = (s) => document.querySelector(s);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const canvas = $('#c');
  const ctx = canvas.getContext('2d');

  const params = new URLSearchParams(location.search);
  const rootName = decodeURIComponent(location.pathname.replace(/^\/|\/$/g, ''));
  // Three ways to build the network. The default follows who follows whom. The other two use a
  // list SoundCloud keeps for each artist: `?mode=related` is "fans also like", `?mode=featured` is
  // the profiles an artist has chosen to feature on their page. Two artists listing each other
  // count as mutual. Those lists come back complete in one request and vary in length (a featured
  // list can be empty), so nothing below assumes a size.
  const MODE = ['related', 'featured'].includes(params.get('mode')) ? params.get('mode') : 'follow';
  const LISTED = MODE !== 'follow'; // the connections come from a list rather than from follows
  const WORDS = {
    related: {
      title: 'Fans Also Like',
      mutual: 'Mutual (list each other)',
      oneWay: 'One-way (listed, not listed back)',
      out: 'lists',
      in: 'listed by',
      load: 'Load related artists',
      loaded: 'Related artists loaded',
      none: 'has no related artists',
    },
    featured: {
      title: 'Featured Profiles',
      mutual: 'Mutual (feature each other)',
      oneWay: 'One-way (featured, not featured back)',
      out: 'features',
      in: 'featured by',
      load: 'Load featured profiles',
      loaded: 'Featured profiles loaded',
      none: 'has no featured profiles',
    },
  }[MODE];
  const MAX_DEPTH = clamp(+params.get('depth') || (MODE === 'featured' ? 8 : LISTED ? 6 : 2), 1, LISTED ? 8 : 4); // how many hops out from the root
  const ROOT_LIMIT = LISTED ? 10 : clamp(+params.get('limit') || 150, 1, 500); // followings loaded for the root
  const CHILD_LIMIT = LISTED ? 10 : clamp(+params.get('child') || 15, 1, 200); // followings loaded for everyone else
  const ALL_LIMIT = LISTED ? 10 : 1000; // most followings loaded when you expand a node by hand
  const MAX_NODES = 5000;
  const CONCURRENCY = 6;

  // search box
  $('#go').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#name').value.trim().replace(/\/+$/, '').split('/').pop();
    if (!v) return;
    const keep = new URLSearchParams(); // stay in the current mode
    for (const k of ['mode', 'maxlinks']) if (params.has(k)) keep.set(k, params.get(k));
    location.href = '/' + encodeURIComponent(v) + (keep.toString() ? '?' + keep : '');
  });
  if (!rootName) return; // the home page is handled by landing.js
  $('#name').placeholder = rootName;

  // mode switch: same person, other kind of network
  const modeBox = $('#mode');
  modeBox.hidden = false;
  for (const a of modeBox.querySelectorAll('a')) {
    const p = new URLSearchParams(location.search);
    ['depth', 'limit', 'child'].forEach((k) => p.delete(k)); // each mode has its own defaults
    if (a.dataset.mode === 'follow') p.delete('mode');
    else p.set('mode', a.dataset.mode);
    a.href = location.pathname + (p.toString() ? '?' + p : '');
    a.classList.toggle('on', a.dataset.mode === MODE);
  }
  if (LISTED) {
    const label = (id, text) => ($(id).parentElement.lastChild.textContent = text);
    label('#t-mutual', WORDS.mutual);
    label('#t-oneway', WORDS.oneWay);
  }

  /* ---------- graph state ---------- */

  const nodes = [];
  const links = [];
  const byId = new Map();
  const linkKeys = new Map();
  let root = null;
  let selected = null;
  let hovered = null;
  // Background loading (the first pass plus the follow-back recheck) stops for good after this long,
  // or sooner once it stops finding anything new, so the page settles instead of shifting forever.
  const SCRAPE_BUDGET_MS = 60000;
  const STALE_LIMIT = 120; // this many rechecks in a row that find nothing new = done
  let scraping = true;

  // circle size follows how connected someone is in this network (links, with mutuals counting
  // double), on a square-root scale so hubs stand out without swallowing everyone else
  // Sizes are relative to the most connected person in this network, over a wide range: the biggest
  // hub gets R_MAX and someone with a couple of connections is a small dot.
  const R_MIN = 4;
  const R_MAX = 64;
  let maxScore = 1;
  let maxFollowers = 1;
  const radiusOf = (n) => {
    if (show.followers) {
      // "Size by follower count": log scale (follower counts run from a handful to millions), squared
      // so the big accounts stand well clear of the small ones
      const t = Math.log10(1 + (n.followers || 0)) / Math.log10(1 + maxFollowers);
      return R_MIN + (R_MAX - R_MIN) * t * t;
    }
    return R_MIN + (R_MAX - R_MIN) * Math.pow(Math.min(1, (n.degree + n.mutuals) / maxScore), 0.9);
  };
  // as the biggest hub grows everyone else's relative size changes, so sizes are refreshed together
  const refreshRadii = () => nodes.forEach((n) => (n.r = radiusOf(n)));

  function addNode(u, parent, depth) {
    let n = byId.get(u.id);
    if (n) return n;
    const a = Math.random() * Math.PI * 2;
    n = Object.assign({}, u, {
      depth,
      degree: 0,
      mutuals: 0,
      links: [], // every link touching this person
      group: -1, // index into `groups`, or -1 if they aren't part of a friend group
      pos: parent, // who they were found through
      loaded: 0,
      loading: false,
      queued: false,
      vx: 0,
      vy: 0,
      x: (parent ? parent.x : 0) + Math.cos(a) * 60,
      y: (parent ? parent.y : 0) + Math.sin(a) * 60,
    });
    maxFollowers = Math.max(maxFollowers, n.followers || 0);
    n.r = radiusOf(n);
    nodes.push(n);
    byId.set(n.id, n);
    return n;
  }

  // One link per pair of people. `source` follows `target`; if the target follows back, `mutual` is set.
  // Only a backbone takes part in the live physics (`treeLinks`, the link each person was discovered
  // through). Feeding tens of thousands of links to the physics is what made the graph slow.
  const treeLinks = [];
  const mutualLinks = [];
  let mutualTotal = 0;
  let physChanged = false;

  // Returns true if the graph changed (a new link, or a one-way link that turned out to be mutual).
  function addLink(a, b, discovered = false) {
    if (a === b) return false;
    const key = a.id < b.id ? a.id + '-' + b.id : b.id + '-' + a.id;
    const existing = linkKeys.get(key);
    if (existing) {
      if (existing.source === a || existing.mutual) return false;
      existing.mutual = true;
      mutualLinks.push(existing);
      mutualTotal++;
      a.mutuals++;
      b.mutuals++;
      maxScore = Math.max(maxScore, a.degree + a.mutuals, b.degree + b.mutuals);
      a.r = radiusOf(a);
      b.r = radiusOf(b);
      scheduleGroups();
      return true;
    }
    const l = { source: a, target: b, mutual: false };
    linkKeys.set(key, l);
    links.push(l);
    a.links.push(l);
    b.links.push(l);
    a.degree++;
    b.degree++;
    maxScore = Math.max(maxScore, a.degree + a.mutuals, b.degree + b.mutuals);
    a.r = radiusOf(a);
    b.r = radiusOf(b);
    if (discovered) {
      treeLinks.push(l);
      physChanged = true;
    }
    return true;
  }

  /* ---------- friend groups ---------- */

  // A friend group is a set of people who mostly follow each other back. We find them by running
  // community detection (Louvain, first phase) on the mutual-follow graph. Each mutual link is
  // weighted by how many friends the two share, so a tight clique binds harder than a one-off
  // friendship. The starting profile is treated like anyone else and can belong to a group.
  const GROUP_RESOLUTION = 1.6; // higher = smaller, tighter groups
  const MAX_GROUP = 25; // bigger groups are split up again
  let groups = []; // { members, hue, cx, cy, R }
  let groupTimer = null;

  // Regroup once new mutuals stop arriving for a few seconds (or every 25s at most while they keep
  // coming). Regrouping constantly would keep dragging people from one group to another.
  let groupFirstCall = 0;
  function scheduleGroups(force = false) {
    if (!scraping && !force) return; // once loading is over only something you did (loading more people) regroups
    const now = Date.now();
    if (!groupFirstCall) groupFirstCall = now;
    clearTimeout(groupTimer);
    groupTimer = setTimeout(() => {
      groupTimer = null;
      groupFirstCall = 0;
      detectGroups();
      graphChanged(0.9);
    }, Math.max(0, Math.min(3000, groupFirstCall + 25000 - now)));
  }

  function detectGroups() {
    const adj = new Map();
    const add = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, new Map());
      adj.get(a).set(b, w);
    };
    for (const l of mutualLinks) {
      add(l.source, l.target, 1);
      add(l.target, l.source, 1);
    }
    for (const [a, nb] of adj) {
      for (const b of nb.keys()) {
        if (a.id > b.id) continue;
        let common = 0;
        const other = adj.get(b);
        for (const c of nb.keys()) if (other.has(c)) common++;
        add(a, b, 1 + common);
        add(b, a, 1 + common);
      }
    }

    // One round of community detection over `members`: everyone starts alone and repeatedly moves
    // to the neighbouring group that most improves modularity, until nobody wants to move.
    const cluster = (members, res) => {
      const inSet = new Set(members);
      const ids = [...members].sort((a, b) => a.id - b.id); // fixed order keeps results stable
      const comm = new Map(ids.map((n, i) => [n, i]));
      const k = new Map();
      let m2 = 0;
      for (const n of ids) {
        let s = 0;
        for (const [nb, w] of adj.get(n)) if (inSet.has(nb)) s += w;
        k.set(n, s);
        m2 += s;
      }
      if (!m2) return [members];
      const total = ids.map((n) => k.get(n)); // total weight per community
      for (let pass = 0; pass < 20; pass++) {
        let moved = false;
        for (const n of ids) {
          const kn = k.get(n), own = comm.get(n);
          const toComm = new Map();
          for (const [nb, w] of adj.get(n)) {
            if (!inSet.has(nb)) continue;
            const c = comm.get(nb);
            toComm.set(c, (toComm.get(c) || 0) + w);
          }
          total[own] -= kn;
          let best = own, bestGain = (toComm.get(own) || 0) - (res * total[own] * kn) / m2;
          for (const [c, w] of toComm) {
            const gain = w - (res * total[c] * kn) / m2;
            if (gain > bestGain + 1e-9) {
              best = c;
              bestGain = gain;
            }
          }
          total[best] += kn;
          if (best !== own) {
            comm.set(n, best);
            moved = true;
          }
        }
        if (!moved) break;
      }
      const byComm = new Map();
      for (const [n, c] of comm) {
        if (!byComm.has(c)) byComm.set(c, []);
        byComm.get(c).push(n);
      }
      return [...byComm.values()];
    };

    // A group that's still too big to be one circle of friends gets split again, more strictly.
    const split = (members, res) => {
      const parts = cluster(members, res);
      if (parts.length === 1 || res > 40) return parts;
      return parts.flatMap((p) => (p.length > MAX_GROUP ? split(p, res * 1.5) : [p]));
    };

    for (const n of nodes) n.group = -1;
    groups = [];
    const parts = split([...adj.keys()], GROUP_RESOLUTION);

    // The starting profile is mutual with people from many different circles, which makes the
    // detection unreliable about where it belongs. Put it in the group holding most of its mutuals.
    if (adj.has(root)) {
      const friends = adj.get(root);
      const mine = (p) => p.reduce((s, n) => s + (friends.has(n) ? 1 : 0), 0); // root isn't its own friend
      const current = parts.find((p) => p.includes(root));
      const best = parts.reduce((a, p) => (mine(p) > mine(a) ? p : a), current || parts[0]);
      if (best !== current) {
        if (current) current.splice(current.indexOf(root), 1);
        best.push(root);
      }
    }

    for (const members of parts) {
      if (members.length < 2) continue;
      const g = { members, hue: (Math.min(...members.map((n) => n.id)) * 47) % 360, cx: 0, cy: 0, R: 0 };
      members.forEach((n) => (n.group = groups.length));
      groups.push(g);
    }

    if (show.groups) layoutGroups();
  }

  /* ---------- layout ---------- */

  const GROUP_GAP = 44; // clear space between one group (or person) and the next
  let laidOut = false; // true once friend groups have been laid out

  // While the network is still loading (or with the friend-group view switched off), a live physics
  // simulation lays it out: everyone held to whoever they were found through, in rings. With the
  // group view on, once friend groups are known layoutGroups() replaces that with a computed layout
  // and everyone eases to their spot.
  const sim = d3
    .forceSimulation(nodes)
    .alphaDecay(0.02)
    .alphaMin(0.01)
    .on('tick', () => (dirty = true))
    .on('end', () => fitted && fitView()); // keep the whole network in view until you take over

  function livePhysics() {
    sim
      .force('x', null)
      .force('y', null)
      .force('link', d3.forceLink(treeLinks).distance((l) => 70 + l.source.r + l.target.r).strength(0.5))
      .force('charge', d3.forceManyBody().strength((d) => -70 - d.r * 5).distanceMax(900))
      .force('collide', d3.forceCollide((d) => d.r + 3))
      .force('ring', d3.forceRadial((d) => d.depth * 380, 0, 0).strength((d) => (d.depth ? 0.05 : 0)));
  }
  livePhysics();

  // Switches the friend-group view on or off. Off goes back to the ungrouped ring layout with the
  // starting profile in the middle, and hides the group backdrops.
  function setGrouping(on) {
    if (!root) return;
    show.groups = on;
    userMoved = false; // the whole layout changes, so let the view refit to it
    if (on) {
      if (!reuseLayout()) detectGroups(); // nothing changed since last time: reuse it, else regroup and lay out
    } else {
      laidOut = false;
      root.fx = 0;
      root.fy = 0;
      livePhysics();
    }
    graphChanged(0.9);
    dirty = true;
  }

  // "Size by follower count": circles are sized by followers instead of by how connected someone is
  // in this network. Sizes shape the grouped layout, so it's laid out again for the new sizes (or a
  // saved one is reused).
  function setSizeMode(on) {
    if (!root) return;
    show.followers = on;
    refreshRadii();
    userMoved = false; // extents change with the sizes, so let the view refit
    if (show.groups && !reuseLayout()) detectGroups();
    graphChanged(show.groups ? 0.9 : 0.5);
    dirty = true;
  }

  // 1. every group's members are packed into a tight, non-overlapping cluster;
  // 2. each group (and each person outside a group) is one bubble, and the bubbles are spaced out
  //    with a small simulation that keeps a clear gap between them and pulls bubbles that follow
  //    each other closer;
  // 3. each person gets a target spot inside their bubble and eases there.
  function layoutGroups() {
    // the starting profile is only pinned to the middle while the network loads; from here on it's
    // laid out like everyone else
    laidOut = true;
    root.fx = null;
    root.fy = null;
    refreshRadii();

    for (const g of groups) {
      const ms = g.members;
      g.cx = ms.reduce((s, n) => s + n.x, 0) / ms.length;
      g.cy = ms.reduce((s, n) => s + n.y, 0) / ms.length;
      // start from where people are now (so regrouping doesn't make everything jump)
      const pts = ms.map((n) => ({
        n,
        r: n.r,
        x: clamp(n.x - g.cx, -60, 60) + (Math.random() - 0.5) * 4,
        y: clamp(n.y - g.cy, -60, 60) + (Math.random() - 0.5) * 4,
      }));
      const at = new Map(pts.map((p) => [p.n, p]));
      const inner = [];
      for (const n of ms) {
        for (const l of n.links) {
          const o = l.mutual && l.source === n && at.get(l.target);
          if (o) inner.push({ source: at.get(n), target: o });
        }
      }
      d3.forceSimulation(pts)
        .force('link', d3.forceLink(inner).distance((l) => 8 + l.source.r + l.target.r).strength(0.7))
        .force('charge', d3.forceManyBody().strength(-15))
        .force('collide', d3.forceCollide((p) => p.r + 2).iterations(4))
        .force('x', d3.forceX(0).strength(0.08))
        .force('y', d3.forceY(0).strength(0.08))
        .stop()
        .tick(200);
      const mx = d3.mean(pts, (p) => p.x), my = d3.mean(pts, (p) => p.y);
      pts.forEach((p) => {
        p.x -= mx;
        p.y -= my;
      });
      g.local = pts;
      g.R = Math.max(...pts.map((p) => Math.hypot(p.x, p.y) + p.r)) + 8;
    }

    const bubbles = [];
    const bubbleOf = new Map();
    for (const g of groups) {
      const b = { g, r: g.R + GROUP_GAP / 2, x: g.cx, y: g.cy };
      bubbles.push(b);
      g.members.forEach((n) => bubbleOf.set(n, b));
    }
    for (const n of nodes) {
      if (n.group >= 0) continue;
      const b = { n, r: n.r + GROUP_GAP / 2, x: n.x, y: n.y };
      bubbles.push(b);
      bubbleOf.set(n, b);
    }
    bubbles.forEach((b, i) => (b.i = i));

    // how strongly each pair of bubbles is tied: mutual links count most, and the link a person
    // was found through keeps them near whoever led to them
    const ties = new Map();
    const tie = (a, b, w) => {
      if (a === b) return;
      const key = a.i < b.i ? a.i * 1e6 + b.i : b.i * 1e6 + a.i;
      const t = ties.get(key);
      if (t) t.w += w;
      else ties.set(key, { source: a, target: b, w });
    };
    for (const l of links) tie(bubbleOf.get(l.source), bubbleOf.get(l.target), l.mutual ? 3 : 1);
    for (const l of treeLinks) tie(bubbleOf.get(l.source), bubbleOf.get(l.target), 4);

    d3.forceSimulation(bubbles)
      .force(
        'link',
        d3
          .forceLink([...ties.values()])
          .distance((l) => l.source.r + l.target.r)
          .strength((l) => Math.min(0.3, 0.04 * Math.sqrt(l.w)))
      )
      .force('charge', d3.forceManyBody().strength((b) => -b.r * 3).distanceMax(900))
      .force('collide', d3.forceCollide((b) => b.r).iterations(6))
      .force('x', d3.forceX(0).strength(0.06))
      .force('y', d3.forceY(0).strength(0.06))
      .stop()
      .tick(400);

    for (const b of bubbles) {
      if (b.g) {
        for (const p of b.g.local) {
          p.n.tx = b.x + p.x;
          p.n.ty = b.y + p.y;
        }
      } else {
        b.n.tx = b.x;
        b.n.ty = b.y;
      }
    }

    applyTargets();
    layoutDoneSig = layoutSig();
    layoutStore[layoutKey()] = { sig: layoutDoneSig, pos: new Map(nodes.map((n) => [n, [n.tx, n.ty]])) };
  }

  // Swaps the live physics for easing everyone towards their computed spot (n.tx, n.ty).
  function applyTargets() {
    sim
      .force('link', null)
      .force('charge', null)
      .force('ring', null)
      .force('collide', d3.forceCollide((d) => d.r + 1))
      .force('x', d3.forceX((n) => n.tx ?? n.x).strength(0.2))
      .force('y', d3.forceY((n) => n.ty ?? n.y).strength(0.2));
  }

  // The grouped layout takes a few seconds to compute, so finished layouts are remembered (one for
  // each way of sizing circles, since sizes shape the layout). If nothing that affects a layout (the
  // people and mutual links) has changed since, switching back to it just reapplies it.
  const layoutSig = () => nodes.length + ':' + mutualTotal;
  const layoutKey = () => (show.followers ? 'followers' : 'connections');
  const layoutStore = {}; // key -> { sig, pos: Map(person -> [x, y]) }
  let layoutDoneSig = null;

  // true if a saved layout for the current sizing is still valid, and has been applied
  function reuseLayout() {
    const saved = layoutStore[layoutKey()];
    if (!saved || saved.sig !== layoutSig()) return false;
    for (const [n, [x, y]] of saved.pos) {
      n.tx = x;
      n.ty = y;
    }
    laidOut = true;
    root.fx = null;
    root.fy = null;
    applyTargets();
    layoutDoneSig = saved.sig;
    return true;
  }

  let reheatTimer = null;
  let reheatStrength = 0;
  function graphChanged(strength = 0.4) {
    sim.nodes(nodes);
    if (sim.force('link')) sim.force('link').links(treeLinks);
    physChanged = false;
    scheduleSidebar();
    reheatStrength = Math.max(reheatStrength, strength);
    if (!reheatTimer) {
      reheatTimer = setTimeout(() => {
        reheatTimer = null;
        refreshRadii();
        if (selected) select(selected); // pick up new neighbours and stats
        sim.alpha(Math.max(sim.alpha(), reheatStrength)).restart();
        reheatStrength = 0;
      }, 150);
    }
    dirty = true;
  }

  /* ---------- canvas, zoom, drag ---------- */

  let W = 0, H = 0, dpr = 1, dirty = true;
  let t = d3.zoomIdentity;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5); // a sharper canvas costs a lot for little gain
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    dirty = true;
  }
  window.addEventListener('resize', resize);
  resize();

  const zoom = d3
    .zoom()
    .scaleExtent([0.05, 6])
    .on('zoom', (e) => {
      t = e.transform;
      if (e.sourceEvent) userMoved = true;
      dirty = true;
    });
  const sel = d3.select(canvas);
  sel.call(zoom).on('dblclick.zoom', null);
  sel.call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(0.45));

  function nodeAt(x, y) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const dx = n.x - x, dy = n.y - y;
      const r = n.r + 2 / t.k;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }
  const worldPoint = (e) => t.invert([e.clientX, e.clientY]);

  sel.call(
    d3
      .drag()
      .subject((e) => {
        const [x, y] = t.invert([e.x, e.y]);
        const n = nodeAt(x, y);
        return n ? { node: n, x: t.applyX(n.x), y: t.applyY(n.y) } : null;
      })
      .on('start', (e) => {
        if (!e.active) sim.alphaTarget(0.3).restart();
        const n = e.subject.node;
        n.fx = n.x;
        n.fy = n.y;
      })
      .on('drag', (e) => {
        const [x, y] = t.invert([e.x, e.y]);
        e.subject.node.fx = x;
        e.subject.node.fy = y;
      })
      .on('end', (e) => {
        if (!e.active) sim.alphaTarget(0);
        const n = e.subject.node;
        if (n !== root || laidOut) {
          n.fx = null;
          n.fy = null;
        }
      })
  );

  canvas.addEventListener('mousemove', (e) => {
    const [x, y] = worldPoint(e);
    const n = nodeAt(x, y);
    canvas.classList.toggle('hover', !!n);
    setHover(n);
  });
  canvas.addEventListener('mouseleave', () => setHover(null));
  canvas.addEventListener('click', (e) => {
    const [x, y] = worldPoint(e);
    select(nodeAt(x, y));
  });
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = worldPoint(e);
    const n = nodeAt(x, y);
    if (n) expandManually(n);
  });

  // zoom out (or in) so the bulk of the network fits the screen, ignoring a few far-flung outliers
  let userMoved = false;
  let fitted = false; // set once the first load is done
  function fitView() {
    if (userMoved || nodes.length < 2) return;
    const q = (vals, p) => vals.sort((a, b) => a - b)[Math.floor(p * (vals.length - 1))];
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const [xa, xb, ya, yb] = [q(xs, 0.02), q(xs, 0.98), q(ys, 0.02), q(ys, 0.98)];
    const k = clamp(Math.min(viewW() / (xb - xa + 120), H / (yb - ya + 120)), 0.08, 1);
    sel
      .transition()
      .duration(900)
      .call(zoom.transform, d3.zoomIdentity.translate(viewCX(), H / 2).scale(k).translate(-(xa + xb) / 2, -(ya + yb) / 2));
  }

  // the part of the window not covered by the info panel (left) or the sidebar (right)
  const visible = (el) => (el && el.getClientRects().length ? el.offsetWidth : 0);
  const viewLeft = () => (visible($('#panel')) ? visible($('#panel')) + 32 : 0);
  const viewW = () => W - viewLeft() - visible($('#sidebar'));
  const viewCX = () => viewLeft() + viewW() / 2;

  function focusOn(n, k = 1.2) {
    userMoved = true; // you've chosen where to look, so stop auto-fitting the whole network
    sel
      .transition()
      .duration(600)
      .call(zoom.transform, d3.zoomIdentity.translate(viewCX(), H / 2).scale(Math.max(t.k, k)).translate(-n.x, -n.y));
  }

  function focusGroup(g) {
    userMoved = true;
    const cx = d3.mean(g.members, (n) => n.x), cy = d3.mean(g.members, (n) => n.y);
    const reach = Math.max(...g.members.map((n) => Math.hypot(n.x - cx, n.y - cy) + n.r)) + 80;
    const k = clamp(Math.min(viewW() / (reach * 2), H / (reach * 2)), 0.2, 2.5);
    sel
      .transition()
      .duration(600)
      .call(zoom.transform, d3.zoomIdentity.translate(viewCX(), H / 2).scale(k).translate(-cx, -cy));
  }

  /* ---------- drawing ---------- */

  const PFP_MIN_PX = 9; // below this on-screen radius a node is just a flat colour
  const BASE_LINK_MAX = 300; // background links longer than this (in graph units) aren't drawn

  // Hard cap on how many connections are drawn at once, however big the network is (tens of
  // thousands of lines every frame is what makes it lag). Change it with ?maxlinks=. The links of
  // the selected/hovered person count towards it too, and take at most a third of it. Long links
  // are what cost the most to draw, and the grouped view's are short (they stay inside a friend
  // group), so it's allowed more of them to keep every group's links visible.
  const LINK_CAP = clamp(+params.get('maxlinks') || 400, 0, 30000);
  const GROUPED_LINK_FACTOR = 5;
  const maxLinks = () => LINK_CAP * (show.groups ? GROUPED_LINK_FACTOR : 1);
  const highlightMax = () => Math.floor(maxLinks() / 3);

  const linkScore = (n) => n.degree + n.mutuals;
  const inGroupLink = (l) => l.mutual && show.groups && l.source.group >= 0 && l.source.group === l.target.group;

  // Which links make the cut: those between well-connected people, mutual ones counting double.
  // With the group view on, links inside friend groups come first and smaller groups before bigger
  // ones, so a small circle of friends keeps all of its links. Ranking every link is slow, so the
  // result is reused: it refreshes at once when a link layer is switched, and otherwise at most
  // every 1.5s as the network changes.
  let visCache = [];
  let visFlags = '';
  let visSig = '';
  let visAt = 0;
  function visibleLinks() {
    const flags = [show.groups, show.mutual, show.oneWay].join();
    const sig = [links.length, mutualTotal, layoutDoneSig, groups.length].join(':');
    if (flags !== visFlags || (sig !== visSig && performance.now() - visAt > 1500)) {
      visFlags = flags;
      visSig = sig;
      visAt = performance.now();
      const ranked = [];
      for (const l of links) {
        if (l.mutual ? !show.mutual : !show.oneWay) continue;
        let key = (l.mutual ? 2 : 1) * Math.min(linkScore(l.source), linkScore(l.target));
        if (inGroupLink(l)) key += 1e6 - groups[l.source.group].members.length * 1e3;
        ranked.push([key, l]);
      }
      ranked.sort((a, b) => b[0] - a[0]);
      visCache = ranked.slice(0, maxLinks()).map((r) => r[1]);
    }
    return visCache;
  }

  // a person's own links, best first, for highlighting (cached until their links change)
  function focusLinks(n) {
    const k = highlightMax();
    if (n.flCount !== n.links.length || n.flMax !== k) {
      n.flCount = n.links.length;
      n.flMax = k;
      n.fl = n.links
        .map((l) => [(l.mutual ? 2 : 1) * linkScore(l.source === n ? l.target : l.source), l])
        .sort((a, b) => b[0] - a[0])
        .slice(0, k)
        .map((r) => r[1]);
    }
    return n.fl;
  }

  const sizedUrl = (n, size) =>
    n.avatar.replace(/-(large|crop|t\d+x\d+|badge|small|tiny|mini|original)\./, `-${size}.`);

  const imgs = new Map();
  // `cors` images can be read back for the average colour; not every image host allows that
  // (SoundCloud's default avatar doesn't), so pictures we only draw are loaded the plain way.
  function loadImg(url, { cors = false, onload } = {}) {
    const key = (cors ? 'cors:' : '') + url;
    let rec = imgs.get(key);
    if (!rec) {
      const img = new Image();
      rec = { img, ok: false, failed: false, waiters: [] };
      img.referrerPolicy = 'no-referrer';
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = () => {
        rec.ok = true;
        rec.waiters.forEach((fn) => fn(img));
        dirty = true;
      };
      img.onerror = () => {
        rec.failed = true;
        dirty = true;
      };
      img.src = url;
      imgs.set(key, rec);
    }
    if (onload) {
      if (rec.ok) onload(rec.img);
      else rec.waiters.push(onload);
    }
    return rec;
  }

  // pick the smallest image that still looks sharp at the current zoom
  function avatar(n, px) {
    const size = px > 90 ? 't300x300' : px > 40 ? 'large' : 'badge';
    let rec = loadImg(sizedUrl(n, size));
    if (rec.failed) rec = loadImg(n.avatar); // some sizes don't exist for every avatar
    return rec.ok ? rec.img : null;
  }

  // average colour of a profile pic: load the 16x16 thumbnail once and squash it to one pixel
  const px1 = document.createElement('canvas');
  px1.width = px1.height = 1;
  const px1ctx = px1.getContext('2d', { willReadFrequently: true });
  function averageColor(n) {
    if (n.avg === undefined) {
      n.avg = null;
      if (n.avatar.includes('/images/default_avatar')) return (n.avg = 'rgb(130,130,130)'); // host blocks reading it
      loadImg(sizedUrl(n, 'mini'), {
        cors: true,
        onload: (img) => {
          try {
            px1ctx.clearRect(0, 0, 1, 1);
            px1ctx.drawImage(img, 0, 0, 1, 1);
            const [r, g, b] = px1ctx.getImageData(0, 0, 1, 1).data;
            n.avg = `rgb(${r},${g},${b})`;
          } catch {
            /* image not readable, keep the fallback colour */
          }
        },
      });
    }
    return n.avg;
  }

  const color = (n) => `hsl(${(n.id * 47) % 360} 35% 32%)`;
  const neighbours = new Set();

  // legend checkboxes switch link layers (and the hover preview) on and off
  const show = { mutual: true, oneWay: false, audio: true, groups: true, followers: false }; // followers: off unless switched on
  const remembered = { audio: 'preview', groups: 'groups' }; // choices kept between visits
  try {
    for (const [key, name] of Object.entries(remembered)) show[key] = localStorage.getItem(name) !== '0';
  } catch {
    /* storage unavailable, keep the defaults */
  }
  // With the group view off there are no clusters to keep things tidy, so more of the network is
  // shown: the one-way links are switched on (and longer links drawn, see draw()). The checkbox
  // value the grouped view had is put back when grouping is switched on again.
  let oneWayWhenGrouped = show.oneWay;
  if (!show.groups) show.oneWay = true;
  for (const [id, key] of [['#t-mutual', 'mutual'], ['#t-oneway', 'oneWay'], ['#t-audio', 'audio'], ['#t-groups', 'groups'], ['#t-followers', 'followers']]) {
    const box = $(id);
    box.checked = show[key];
    box.addEventListener('change', () => {
      show[key] = box.checked;
      if (key === 'audio' && !show.audio) stopPreview();
      if (key === 'followers') setSizeMode(show.followers);
      if (key === 'oneWay' && show.groups) oneWayWhenGrouped = show.oneWay;
      if (key === 'groups') {
        if (show.groups) show.oneWay = oneWayWhenGrouped;
        else {
          oneWayWhenGrouped = show.oneWay;
          show.oneWay = true;
        }
        $('#t-oneway').checked = show.oneWay;
        setGrouping(show.groups);
      }
      if (remembered[key]) {
        try {
          localStorage.setItem(remembered[key], show[key] ? '1' : '0');
        } catch {
          /* ignore */
        }
      }
      dirty = true;
    });
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const [x0, y0] = t.invert([0, 0]);
    const [x1, y1] = t.invert([W, H]);

    // friend groups: a soft coloured blob (padded hull) behind each group of 3 or more
    ctx.lineJoin = 'round';
    for (const g of show.groups ? groups : []) {
      if (g.members.length < 3) continue;
      const hull = d3.polygonHull(g.members.map((n) => [n.x, n.y]));
      if (!hull) continue;
      const active = selected && selected.group >= 0 && groups[selected.group] === g;
      // the blob is the hull between the members plus a disc around each one, filled as a single
      // shape so it hugs big and small circles alike without stacking transparency. The hull is
      // wound the same way as the discs, otherwise overlapping shapes would cancel out.
      let winding = 0;
      hull.forEach(([ax, ay], i) => {
        const [bx, by] = hull[(i + 1) % hull.length];
        winding += ax * by - bx * ay;
      });
      if (winding < 0) hull.reverse();
      ctx.beginPath();
      hull.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      for (const n of g.members) {
        ctx.moveTo(n.x + n.r + 10, n.y);
        ctx.arc(n.x, n.y, n.r + 10, 0, Math.PI * 2);
      }
      ctx.fillStyle = `hsla(${g.hue},65%,55%,${active ? 0.14 : 0.07})`;
      ctx.fill();
    }

    // links: mutual = cyan, one-way = grey. Both are drawn faintly (and one-way only if switched on)
    // so the graph stays readable; the links of the selected/hovered person are drawn bright.
    // maxLen: skip very long links in the background layers. Thousands of them crossing the whole
    // graph just turn into a haze, and the ones that matter show up when you select/hover someone.
    const strokeLinks = (list, style, width, pick, maxLen = Infinity) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width / t.k;
      ctx.beginPath();
      for (const l of list) {
        if (pick && !pick(l)) continue;
        const { source: s, target: g } = l;
        if ((s.x < x0 && g.x < x0) || (s.x > x1 && g.x > x1) || (s.y < y0 && g.y < y0) || (s.y > y1 && g.y > y1)) continue;
        if (maxLen < Infinity && (s.x - g.x) ** 2 + (s.y - g.y) ** 2 > maxLen * maxLen) continue;
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(g.x, g.y);
      }
      ctx.stroke();
    };

    const focus = selected || hovered;
    const focused = [...new Set([selected, hovered])].filter(Boolean).map((n) => [n, focusLinks(n)]);
    // the background layers get whatever is left of the cap after the highlighted links
    const room = Math.max(0, maxLinks() - focused.reduce((sum, [, ls]) => sum + ls.length, 0));
    const bg = visibleLinks().slice(0, room);
    const oneWay = (l) => !l.mutual;
    const mutualOnly = (l) => l.mutual;
    if (show.groups) {
      // Grouped: links longer than BASE_LINK_MAX are skipped (they'd just be a haze crossing the
      // whole graph), and friendships inside a group are the point.
      strokeLinks(bg, focus ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.08)', 1, oneWay, BASE_LINK_MAX);
      strokeLinks(bg, focus ? 'rgba(45,212,191,.04)' : 'rgba(45,212,191,.12)', 1, (l) => l.mutual && !inGroupLink(l), BASE_LINK_MAX);
      strokeLinks(bg, focus ? 'rgba(45,212,191,.15)' : 'rgba(45,212,191,.6)', 1.6, inGroupLink);
    } else {
      // Ungrouped: the layout is spread over rings, so most links are long. Draw the ones that made
      // the cut, mutual and one-way alike, at any length.
      strokeLinks(bg, focus ? 'rgba(255,255,255,.04)' : 'rgba(255,255,255,.14)', 1, oneWay);
      strokeLinks(bg, focus ? 'rgba(45,212,191,.06)' : 'rgba(45,212,191,.35)', 1.2, mutualOnly);
    }
    for (const [n, ls] of focused) {
      strokeLinks(ls, n === selected ? 'rgba(255,85,0,.8)' : 'rgba(255,255,255,.6)', 1.5, oneWay);
      strokeLinks(ls, 'rgba(45,212,191,1)', 2.5, mutualOnly);
    }

    // nodes: real pfp when big enough on screen, otherwise a flat average colour (much cheaper)
    for (const n of nodes) {
      if (n.x + n.r < x0 || n.x - n.r > x1 || n.y + n.r < y0 || n.y - n.r > y1) continue;
      const dim = selected && n !== selected && !neighbours.has(n);      ctx.globalAlpha = dim ? 0.25 : 1;
      const px = n.r * t.k;

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = averageColor(n) || color(n);
      ctx.fill();

      if (px >= PFP_MIN_PX) {
        const img = avatar(n, px);
        if (img) {
          ctx.save();
          ctx.clip();
          ctx.drawImage(img, n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
          ctx.restore();
        }
      }
      if (n === selected || n === hovered) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 1.5 / t.k, 0, Math.PI * 2);
        ctx.lineWidth = 2.5 / t.k;
        ctx.strokeStyle = n === selected ? '#f50' : 'rgba(255,255,255,.8)';
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // hover label
    if (hovered) {
      const fs = 13 / t.k;
      ctx.font = `${fs}px Roboto, sans-serif`;
      const w = ctx.measureText(hovered.name).width;
      const lx = hovered.x - w / 2, ly = hovered.y - hovered.r - 10 / t.k;
      ctx.fillStyle = 'rgba(0,0,0,.8)';
      ctx.fillRect(lx - 6 / t.k, ly - fs, w + 12 / t.k, fs + 8 / t.k);
      ctx.fillStyle = '#fff';
      ctx.fillText(hovered.name, lx, ly);
    }
    ctx.restore();
  }

  (function loop() {
    if (dirty) {
      dirty = false;
      draw();
    }
    requestAnimationFrame(loop);
  })();

  /* ---------- info panel ---------- */

  const panel = $('#panel');
  const fmt = (v) => (v || 0).toLocaleString();

  function select(n) {
    selected = n;
    neighbours.clear();
    if (n) for (const l of n.links) neighbours.add(l.source === n ? l.target : l.source);
    dirty = true;
    renderPanel();
    markSelected();
  }

  function renderPanel() {
    const n = selected;
    panel.hidden = !n;
    if (!n) return;
    $('#p-avatar').src = n.avatar.replace('-large.', '-t300x300.');
    $('#p-name').textContent = n.name;
    $('#p-user').textContent = '@' + n.username + (n.fullName && n.fullName !== n.name ? ' · ' + n.fullName : '');
    $('#p-stats').replaceChildren(
      ...[
        ['Followers', n.followers],
        ['Following', n.followings],
        ['Tracks', n.tracks],
      ].map(([label, v]) => {
        const d = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = fmt(v);
        d.append(b, label);
        return d;
      })
    );
    let follows = 0, followedBy = 0;
    for (const l of n.links) {
      if (l.mutual) continue;
      if (l.source === n) follows++;
      else followedBy++;
    }
    $('#p-net').textContent = n.degree
      ? `In this network: ${n.mutuals} mutual · ${LISTED ? WORDS.out : 'follows'} ${follows} · ${LISTED ? WORDS.in : 'followed by'} ${followedBy}` +
        (n.group >= 0 ? ` · in a friend group of ${groups[n.group].members.length}` : '')
      : '';
    $('#p-loc').textContent = [n.city, n.country].filter(Boolean).join(', ');
    $('#p-bio').textContent = n.description;
    $('#p-link').href = n.url;
    $('#p-center').href = '/' + encodeURIComponent(n.username);
    const btn = $('#p-expand');
    const total = Math.min(n.followings, ALL_LIMIT);
    btn.disabled = n.loading || fullyLoaded(n);
    btn.textContent = n.loading
      ? 'Loading…'
      : LISTED
        ? fullyLoaded(n) ? WORDS.loaded : WORDS.load
        : fullyLoaded(n)
          ? n.followings ? 'All followings loaded' : 'Follows nobody'
          : `Load all ${fmt(total)} followings`;
  }

  $('#close').addEventListener('click', () => select(null));
  $('#p-expand').addEventListener('click', () => selected && expandManually(selected));

  /* ---------- loading the network ---------- */

  const status = $('#status');
  const queue = [];
  let running = 0;

  // Progress bar shown along the top while the network is being generated (the network itself stays
  // visible and keeps growing underneath). It mixes real work done with the time limit, so it always
  // reaches 100% by the time loading stops, and it never goes backwards.
  const bar = $('#progress');
  const barFill = $('#pg-fill');
  let loadsDone = 0; // people whose connections have been loaded
  let checksDone = 0; // people whose follow-backs have been rechecked
  let shown = 0;
  let startedAt = 0;
  let barTimer = null;

  function progress() {
    if (!scraping) return 1;
    const loading = loadsDone / Math.max(1, loadsDone + running + queue.length);
    let work = loading;
    if (!LISTED) {
      // following mode: loading people is the first third, rechecking follow-backs the rest
      const checking = checksDone / Math.max(1, checksDone + verifying + verifyQueue.length);
      work = 0.35 * loading + 0.65 * checking;
    }
    const time = startedAt ? (performance.now() - startedAt) / SCRAPE_BUDGET_MS : 0;
    return Math.min(0.99, Math.max(work, time));
  }

  function updateProgress() {
    shown = Math.max(shown, progress());
    barFill.style.width = (shown * 100).toFixed(1) + '%';
    return shown;
  }

  const setStatus = (msg) => (status.textContent = msg);
  function updateStatus() {
    const busy = running + queue.length;
    const checking = verifying + verifyQueue.length;
    if (!scraping && LISTED && root && nodes.length <= 1) return setStatus(`${root.name} ${WORDS.none}, so there's no network to show.`);
    setStatus(
      (scraping && startedAt ? `Generating ${Math.round(updateProgress() * 100)}% · ` : '') +
      `${fmt(nodes.length)} people · ${fmt(links.length)} connections · ${fmt(mutualTotal)} mutual` +
        (!scraping
          ? ''
          : busy
            ? ` · loading (${busy} left)…`
            : checking
              ? ` · checking for more mutuals (${fmt(checking)} left)…`
              : '')
    );
  }

  async function api(path) {
    const res = await fetch(path);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  // n.loaded = how many followings we've asked for so far (Infinity once we've got everyone)
  // (in "fans also like" mode the list is always complete after one load)
  // (with a list mode the list is complete after one load, however long or short it turns out to be)
  const fullyLoaded = (n) => (LISTED ? n.loaded > 0 : n.loaded >= Math.min(n.followings, ALL_LIMIT));

  async function expand(n, limit, recurseTo) {
    if (n.loading || (LISTED ? n.loaded > 0 : n.loaded >= Math.min(limit, n.followings))) return;
    n.loading = true;
    if (n === selected) renderPanel();
    try {
      const list = await api(LISTED ? `/api/${MODE}/${n.id}` : `/api/followings/${n.id}?limit=${limit}`);
      n.loaded = list.length < limit ? Infinity : limit;
      for (const u of list) {
        if (!byId.has(u.id) && nodes.length >= MAX_NODES) continue;
        const isNew = !byId.has(u.id);
        const child = addNode(u, n, n.depth + 1);
        addLink(n, child, isNew);
        if (n.depth + 1 < recurseTo && !child.queued) {
          child.queued = true;
          queue.push(child);
        }
      }
      graphChanged();
    } catch (err) {
      console.warn('Could not load followings for', n.username, err.message);
    }
    n.loading = false;
    if (n === selected) renderPanel();
  }

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const n = queue.shift();
      running++;
      expand(n, CHILD_LIMIT, MAX_DEPTH).finally(() => {
        running--;
        loadsDone++;
        pump();
      });
    }
    if (!running && !queue.length) {
      if (!fitted) {
        fitted = true;
        setTimeout(fitView, 2500); // let the layout settle first
      }
      startVerify();
    }
    updateStatus();
  }

  async function expandManually(n) {
    if (fullyLoaded(n)) return;
    setStatus(`Loading who ${n.name} follows…`);
    await expand(n, ALL_LIMIT, n.depth + 1);
    scheduleGroups(true); // anyone new needs a place in the layout
    updateStatus();
  }

  /* ---------- recheck pass: find follow-backs ---------- */

  // The first pass only reads ~15 followings per person, so most follow-backs are missed.
  // Once it's done, read each person's *complete* list and link them to anyone already in the
  // graph. That adds no new people, only connections (and turns one-way links into mutual ones).
  const VERIFY_CONCURRENCY = 3;
  const verifyQueue = [];
  let verifying = 0;

  // Ends all background loading. Requests already in flight finish, but nothing new starts, and
  // the groups are worked out one last time so the page stays as it is from here on.
  function stopScraping() {
    if (!scraping) return;
    scraping = false;
    queue.length = 0;
    verifyQueue.length = 0;
    clearInterval(barTimer);
    shown = 1;
    barFill.style.width = '100%';
    setTimeout(() => bar.classList.add('done'), 700); // hold at 100% briefly, then fade out
    setTimeout(() => (bar.hidden = true), 1500);
    if (groupTimer || mutualLinks.length) {
      clearTimeout(groupTimer);
      groupTimer = null;
      groupFirstCall = 0;
      detectGroups();
      graphChanged(0.9);
    }
    updateStatus();
  }

  function startVerify() {
    if (!scraping) return;
    if (LISTED) return stopScraping(); // nothing to recheck: each list arrives complete
    const todo = nodes.filter((n) => n.depth <= MAX_DEPTH && !n.checked && !n.checking && !n.vq && !fullyLoaded(n));
    // people closest to the centre first, then the best connected
    todo.sort((a, b) => a.depth - b.depth || b.degree - a.degree);
    for (const n of todo) {
      n.vq = true;
      verifyQueue.push(n);
    }
    pumpVerify();
    if (!todo.length && !verifying && !verifyQueue.length) stopScraping(); // nothing to recheck
  }

  function pumpVerify() {
    // only run while the main load is idle, so it never slows down what you're waiting for
    while (scraping && verifying < VERIFY_CONCURRENCY && verifyQueue.length && !running && !queue.length) {
      const n = verifyQueue.shift();
      n.vq = false;
      n.checking = true;
      verifying++;
      checkFollowBacks(n).finally(() => {
        n.checking = false;
        n.checked = true;
        verifying--;
        checksDone++;
        updateStatus();
        pumpVerify();
        if (scraping && !verifying && !verifyQueue.length && !running && !queue.length) stopScraping(); // all checked
      });
    }
    updateStatus();
  }

  let staleChecks = 0;
  async function checkFollowBacks(n) {
    try {
      const ids = await api(`/api/followings/${n.id}?limit=${ALL_LIMIT}&ids=1`);
      let changed = false;
      for (const id of ids) {
        const other = byId.get(id);
        if (other && addLink(n, other)) changed = true;
      }
      if (physChanged) graphChanged(0.15); // only re-layout when the layout links changed
      else if (changed) dirty = true;
      // stop early once a long run of rechecks turns up nothing new
      staleChecks = changed ? 0 : staleChecks + 1;
      if (staleChecks >= STALE_LIMIT) stopScraping();
    } catch (err) {
      console.warn('Could not check followings for', n.username, err.message);
    }
  }

  /* ---------- hover preview ---------- */

  // Hovering someone plays a short stretch from the early-middle of their latest track.
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = 0;
  const trackCache = new Map(); // person id -> { at, promise }
  const nowPlaying = $('#nowplaying');
  let previewFor = null;
  let previewTimer = null;
  let fadeTimer = null;
  let noticeTimer = null;

  function notice(text, ms) {
    nowPlaying.textContent = text;
    nowPlaying.hidden = false;
    clearTimeout(noticeTimer);
    if (ms) noticeTimer = setTimeout(() => (nowPlaying.hidden = true), ms);
  }

  function latestTrack(n) {
    const hit = trackCache.get(n.id);
    if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.promise; // stream links expire
    const promise = api(`/api/track/${n.id}`).catch(() => null);
    trackCache.set(n.id, { at: Date.now(), promise });
    return promise;
  }

  function fadeTo(volume, ms, done) {
    clearInterval(fadeTimer);
    const from = audio.volume;
    let step = 0;
    fadeTimer = setInterval(() => {
      step++;
      audio.volume = clamp(from + ((volume - from) * step) / 10, 0, 1);
      if (step >= 10) {
        clearInterval(fadeTimer);
        if (done) done();
      }
    }, ms / 10);
  }

  async function startPreview(n) {
    const info = await latestTrack(n);
    if (previewFor !== n || !info || !show.audio) return; // moved on, nothing to play, or switched off
    audio.onloadedmetadata = () => {
      if (previewFor !== n) return;
      const length = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : info.duration / 1000;
      audio.currentTime = length * (0.2 + Math.random() * 0.25); // somewhere in the early middle
      audio
        .play()
        .then(() => {
          if (previewFor !== n) return;
          notice(`♪ ${info.title} — ${n.name}`);
          fadeTo(0.7, 300);
        })
        .catch((err) => {
          if (err.name === 'NotAllowedError') notice('Click anywhere on the page once to enable hover previews', 4000);
        });
    };
    audio.volume = 0;
    audio.src = info.url;
  }

  function stopPreview() {
    previewFor = null;
    clearTimeout(previewTimer);
    fadeTo(0, 200, () => {
      if (!previewFor) audio.pause();
    });
    if (!nowPlaying.textContent.startsWith('Click')) nowPlaying.hidden = true;
  }

  function setHover(n) {
    if (n === hovered) return;
    hovered = n;
    dirty = true;
    stopPreview();
    if (n && show.audio && !musicPlaying()) {
      previewFor = n;
      previewTimer = setTimeout(() => startPreview(n), 250); // ignore mouse sweeps across the graph
    }
  }
  document.addEventListener('visibilitychange', () => document.hidden && setHover(null));

  /* ---------- people sidebar ---------- */

  // Lists everyone by how connected they are, or grouped by friend group, with search. Clicking a
  // person (or a group) zooms to them.
  const sidebar = $('#sidebar');
  const sbList = $('#sb-list');
  const sbSearch = $('#sb-search');
  const sbOpen = () => document.body.classList.contains('sb-open');
  const score = (n) => n.degree + n.mutuals;
  const MAX_ROWS = 200;
  let sbView = 'connected';
  let sbTimer = null;
  let sbFirstHit = null;
  const openGroups = new Set(); // groups the person has expanded, so a refresh keeps them open

  function scheduleSidebar() {
    if (!sbOpen() || sbView === 'music') return; // the playlist is built once, not as the network changes
    clearTimeout(sbTimer);
    sbTimer = setTimeout(renderSidebar, 1200);
  }

  function goTo(n) {
    select(n);
    focusOn(n, 2);
  }

  function personRow(n) {
    const row = document.createElement('div');
    row.className = 'sb-row' + (n === selected ? ' on' : '');
    row.dataset.id = n.id;
    const img = new Image();
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = sizedUrl(n, 'badge');
    const text = document.createElement('div');
    text.className = 'sb-txt';
    const name = document.createElement('b');
    name.textContent = n.name;
    const sub = document.createElement('span');
    sub.textContent = `${fmt(score(n))} connections · ${fmt(n.mutuals)} mutual`;
    text.append(name, sub);
    row.append(img, text);
    if (n.group >= 0) {
      const dot = document.createElement('i');
      dot.className = 'sb-dot';
      dot.style.background = `hsl(${groups[n.group].hue} 65% 55%)`;
      row.append(dot);
    }
    row.addEventListener('click', () => goTo(n));
    row.addEventListener('mouseenter', () => setHover(n));
    row.addEventListener('mouseleave', () => setHover(null));
    return row;
  }

  const note = (text) => {
    const d = document.createElement('div');
    d.className = 'sb-note';
    d.textContent = text;
    return d;
  };

  function groupBlock(title, sub, members, key, onOpen, hue) {
    const box = document.createElement('details');
    box.className = 'sb-group';
    const head = document.createElement('summary');
    if (hue !== undefined) {
      const dot = document.createElement('i');
      dot.className = 'sb-dot';
      dot.style.background = `hsl(${hue} 65% 55%)`;
      head.append(dot);
    }
    const text = document.createElement('div');
    text.className = 'sb-txt';
    const t1 = document.createElement('b');
    t1.textContent = title;
    const t2 = document.createElement('span');
    t2.textContent = sub;
    text.append(t1, t2);
    head.append(text);
    box.append(head);
    const fill = () => {
      if (box.querySelector('.sb-row')) return;
      const sorted = [...members].sort((a, b) => score(b) - score(a));
      box.append(...sorted.slice(0, MAX_ROWS).map(personRow));
      if (sorted.length > MAX_ROWS) box.append(note(`…and ${sorted.length - MAX_ROWS} more`));
    };
    box.addEventListener('toggle', () => {
      if (box.open) {
        openGroups.add(key);
        fill();
      } else openGroups.delete(key);
    });
    head.addEventListener('click', () => onOpen && onOpen());
    box.open = openGroups.has(key);
    return box;
  }

  function renderSidebar() {
    clearTimeout(sbTimer);
    if (sbView === 'music') return renderMusic();
    const q = sbSearch.value.trim().toLowerCase();
    const top = sbList.scrollTop;
    const items = [];
    sbFirstHit = null;

    if (q) {
      const hits = nodes
        .filter((n) => [n.name, n.username, n.fullName].some((s) => s && s.toLowerCase().includes(q)))
        .sort((a, b) => score(b) - score(a));
      sbFirstHit = hits[0] || null;
      items.push(note(`${fmt(hits.length)} result${hits.length === 1 ? '' : 's'}`));
      items.push(...hits.slice(0, MAX_ROWS).map(personRow));
    } else if (sbView === 'connected') {
      const sorted = [...nodes].sort((a, b) => score(b) - score(a));
      items.push(...sorted.slice(0, MAX_ROWS).map(personRow));
      if (sorted.length > MAX_ROWS) items.push(note(`Showing the ${MAX_ROWS} most connected of ${fmt(sorted.length)} — search to find anyone`));
    } else {
      const ranked = groups
        .map((g) => ({ g, top: [...g.members].sort((a, b) => score(b) - score(a)) }))
        .sort((a, b) => b.g.members.length - a.g.members.length || score(b.top[0]) - score(a.top[0]));
      for (const { g, top: best } of ranked) {
        const key = Math.min(...g.members.map((n) => n.id));
        items.push(
          groupBlock(`Friend group of ${g.members.length}`, best.slice(0, 3).map((n) => n.name).join(', '), g.members, key, () => focusGroup(g), g.hue)
        );
      }
      const loose = nodes.filter((n) => n.group < 0);
      if (loose.length) items.push(groupBlock(`Not in a group (${fmt(loose.length)})`, 'People with no close mutual circle', loose, 'loose'));
      if (!groups.length) items.unshift(note('Friend groups appear once the mutual check has run.'));
    }
    sbList.replaceChildren(...items);
    sbList.scrollTop = top;
  }

  function markSelected() {
    for (const r of sbList.querySelectorAll('.sb-row.on')) r.classList.remove('on');
    if (selected) {
      const r = sbList.querySelector(`.sb-row[data-id="${selected.id}"]`);
      if (r) r.classList.add('on');
    }
  }

  /* ---------- music tab ---------- */

  // A little playlist: the latest track of the most connected people, best-connected first. Tracks
  // are looked up in batches, so it fills in as they arrive. It has its own player; hover previews
  // stay quiet while it's playing so the two never overlap.
  const BATCH = 25; // people looked up per batch
  const music = { list: [], asked: new Set(), rank: 0, pending: 0, current: null, firstHit: null };
  const mAudio = new Audio();
  mAudio.preload = 'auto';
  mAudio.volume = 0.9;
  const musicPlaying = () => !mAudio.paused && !mAudio.ended;
  const mp = {}; // the now-playing card's elements, replaced whenever the tab is redrawn

  const clock = (s) => (isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  const trackArt = (t) => t.info.artwork || sizedUrl(t.node, 'large');

  async function loadMusic() {
    if (music.pending) return;
    const pool = nodes
      .filter((n) => !music.asked.has(n.id) && n.tracks > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, BATCH);
    if (!pool.length) return renderMusic();
    music.pending = pool.length;
    let next = 0;
    const worker = async () => {
      while (next < pool.length) {
        const n = pool[next++];
        music.asked.add(n.id);
        const rank = music.rank++;
        const info = await latestTrack(n);
        music.pending--;
        if (info) {
          music.list.push({ node: n, info, rank, failed: false });
          music.list.sort((a, b) => a.rank - b.rank);
        }
        if (sbView === 'music') renderMusic();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (sbView === 'music') renderMusic();
  }

  function playTrack(t) {
    if (!t) return;
    stopPreview(); // hover previews and the playlist never overlap
    music.current = t;
    mAudio.src = t.info.url;
    mAudio.play().catch((err) => err.name === 'NotAllowedError' && notice('Click the play button to start the music', 3000));
    refreshPlayer();
  }

  function stepTrack(dir) {
    const list = music.list.filter((t) => !t.failed);
    if (!list.length) return;
    const at = list.indexOf(music.current);
    playTrack(list[(at + dir + list.length) % list.length]);
  }

  mAudio.addEventListener('ended', () => stepTrack(1));
  mAudio.addEventListener('error', () => {
    // a stream that won't play (expired link, removed track) is skipped
    if (!music.current) return;
    music.current.failed = true;
    stepTrack(1);
  });
  for (const ev of ['play', 'pause', 'loadedmetadata']) mAudio.addEventListener(ev, refreshPlayer);
  mAudio.addEventListener('timeupdate', () => {
    if (!mp.fill || !mp.fill.isConnected) return;
    const d = mAudio.duration || (music.current ? music.current.info.duration / 1000 : 0);
    mp.fill.style.width = d ? `${Math.min(100, (mAudio.currentTime / d) * 100)}%` : '0%';
    mp.time.textContent = `${clock(mAudio.currentTime)} / ${clock(d)}`;
  });

  // updates the now-playing card and the highlighted row without redrawing the list
  function refreshPlayer() {
    if (mp.card && mp.card.isConnected) {
      const t = music.current;
      mp.title.textContent = t ? t.info.title : 'Nothing playing';
      mp.artist.textContent = t ? t.node.name : 'Pick a track, or press play';
      mp.art.src = t ? trackArt(t) : '';
      mp.art.style.visibility = t ? 'visible' : 'hidden';
      mp.play.textContent = musicPlaying() ? '⏸' : '▶';
      mp.locate.hidden = !t;
    }
    for (const row of sbList.querySelectorAll('.mt-row')) {
      row.classList.toggle('on', !!music.current && +row.dataset.id === music.current.node.id);
      row.classList.toggle('live', row.classList.contains('on') && musicPlaying());
    }
  }

  function playerCard() {
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const card = el('div', 'mp-card');
    const top = el('div', 'mp-top');
    const art = new Image();
    art.className = 'mp-art';
    art.referrerPolicy = 'no-referrer';
    art.alt = '';
    const text = el('div', 'mp-text');
    const title = el('b', 'mp-title');
    const artist = el('span', 'mp-artist');
    text.append(title, artist);
    const locate = el('button', 'mp-btn small', '◎');
    locate.title = 'Show them in the network';
    locate.addEventListener('click', () => music.current && goTo(music.current.node));
    top.append(art, text, locate);

    const seek = el('div', 'mp-seek');
    const fill = el('div', 'mp-fill');
    seek.append(fill);
    seek.addEventListener('click', (e) => {
      const d = mAudio.duration;
      if (!music.current || !isFinite(d)) return;
      const r = seek.getBoundingClientRect();
      mAudio.currentTime = d * clamp((e.clientX - r.left) / r.width, 0, 1);
    });

    const bar = el('div', 'mp-bar');
    const time = el('span', 'mp-time', '0:00 / 0:00');
    const prev = el('button', 'mp-btn', '⏮');
    const play = el('button', 'mp-btn big');
    const nextBtn = el('button', 'mp-btn', '⏭');
    prev.addEventListener('click', () => (mAudio.currentTime > 3 ? (mAudio.currentTime = 0) : stepTrack(-1)));
    nextBtn.addEventListener('click', () => stepTrack(1));
    play.addEventListener('click', () => {
      if (!music.current) return playTrack(music.list.find((t) => !t.failed));
      if (musicPlaying()) mAudio.pause();
      else mAudio.play().catch(() => {});
    });
    bar.append(time, prev, play, nextBtn);

    card.append(top, seek, bar);
    Object.assign(mp, { card, title, artist, art, play, fill, time, locate });
    return card;
  }

  function trackRow(t) {
    const row = document.createElement('div');
    row.className = 'sb-row mt-row' + (t.failed ? ' failed' : '');
    row.dataset.id = t.node.id;
    const img = new Image();
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    img.src = trackArt(t);
    const text = document.createElement('div');
    text.className = 'sb-txt';
    const name = document.createElement('b');
    name.textContent = t.info.title;
    const sub = document.createElement('span');
    sub.textContent = `${t.node.name} · ${clock(t.info.duration / 1000)}`;
    text.append(name, sub);
    const eq = document.createElement('i');
    eq.className = 'mt-eq';
    eq.textContent = '♪';
    row.append(img, text, eq);
    row.addEventListener('click', () => playTrack(t));
    return row;
  }

  function renderMusic() {
    const q = sbSearch.value.trim().toLowerCase();
    const top = sbList.scrollTop;
    const shown = music.list.filter((t) => !q || t.info.title.toLowerCase().includes(q) || t.node.name.toLowerCase().includes(q));
    music.firstHit = shown.find((t) => !t.failed) || null;

    const items = [playerCard(), ...shown.map(trackRow)];
    if (music.pending) items.push(note(`Finding tracks… ${music.pending} people left to check`));
    else if (!music.list.length) items.push(note('No playable tracks found yet.'));
    else if (q && !shown.length) items.push(note('No tracks match that search.'));
    if (!music.pending) {
      const more = document.createElement('button');
      more.className = 'mt-more';
      more.textContent = 'Find more tracks';
      more.addEventListener('click', loadMusic);
      items.push(more);
    }
    sbList.replaceChildren(...items);
    sbList.scrollTop = top;
    refreshPlayer();
    mAudio.dispatchEvent(new Event('timeupdate'));
  }

  function setSidebar(open) {
    document.body.classList.toggle('sb-open', open);
    $('#sb-toggle').textContent = open ? 'Hide' : 'People';
    if (open) renderSidebar();
  }
  $('#sb-toggle').addEventListener('click', () => setSidebar(!sbOpen()));
  sbSearch.addEventListener('input', renderSidebar);
  sbSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && sbView === 'music') playTrack(music.firstHit);
    else if (e.key === 'Enter' && sbFirstHit) goTo(sbFirstHit);
    if (e.key === 'Escape') {
      sbSearch.value = '';
      renderSidebar();
    }
  });
  for (const tab of document.querySelectorAll('#sb-tabs button')) {
    tab.addEventListener('click', () => {
      sbView = tab.dataset.view;
      document.querySelectorAll('#sb-tabs button').forEach((b) => b.classList.toggle('on', b === tab));
      sbSearch.placeholder = sbView === 'music' ? 'Search tracks and artists' : 'Search people in this network';
      renderSidebar();
      if (sbView === 'music' && !music.asked.size) loadMusic(); // first visit: build the playlist
    });
  }
  setSidebar(window.innerWidth >= 1000);

  /* ---------- search suggestions ---------- */

  // The top search box lists SoundCloud profiles as you type (see search.js). Clicking one opens a new
  // network centred on them, in the same mode. Enter with nothing highlighted opens the typed username.
  function openProfile(u) {
    const keep = new URLSearchParams();
    for (const k of ['mode', 'maxlinks']) if (params.has(k)) keep.set(k, params.get(k));
    location.href = '/' + encodeURIComponent(u.username) + (keep.toString() ? '?' + keep : '');
  }
  attachProfileSearch({ input: $('#name'), box: $('#suggestions'), form: $('#go'), open: openProfile });

  /* ---------- start ---------- */

  (async function start() {
    try {
      setStatus(`Looking up ${rootName}…`);
      const u = await api(`/api/user/${encodeURIComponent(rootName)}`);
      root = addNode(u, null, 0);
      root.fx = 0;
      root.fy = 0;
      root.r = radiusOf(root);
      document.title = `${root.name} · SoundCloud ${LISTED ? WORDS.title : 'Network'}`;
      graphChanged();
      select(root);
      // the root is loaded with a bigger limit than everyone else
      setTimeout(stopScraping, SCRAPE_BUDGET_MS);
      startedAt = performance.now();
      bar.hidden = false;
      barTimer = setInterval(updateStatus, 300); // keeps the bar moving with the time limit too
      await expand(root, ROOT_LIMIT, MAX_DEPTH);
      loadsDone++;
      pump();
    } catch (err) {
      setStatus(err.message === 'User not found' ? `Couldn't find "${rootName}" on SoundCloud.` : 'Error: ' + err.message);
    }
  })();
})();
