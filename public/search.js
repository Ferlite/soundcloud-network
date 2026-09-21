// SoundCloud-wide profile search with a suggestions dropdown. Used by both the search box on the
// network page and the one on the home page:
//   attachProfileSearch({ input, box, form, open })
// As you type it lists profiles whose name or username starts with the text (biggest first, with
// their pfps). `open(profile)` is called when one is picked; the last row (and Enter with nothing
// highlighted) submits the form to open whatever was typed directly.
(() => {
  const fmt = (v) => (v || 0).toLocaleString();
  const SUGGESTIONS = 8;

  window.attachProfileSearch = ({ input, box, form, open }) => {
    let list = [];
    let at = -1;
    let timer = null;
    let token = 0; // lets a slow, out-of-date search be ignored

    const term = () => input.value.trim().replace(/\/+$/, '').split('/').pop();

    function close() {
      clearTimeout(timer);
      token++;
      box.hidden = true;
      list = [];
      at = -1;
    }

    function highlight() {
      box.querySelectorAll('.sg-row').forEach((r, i) => r.classList.toggle('on', i === at));
    }

    // profiles === null means the search is still running
    function show(q, profiles) {
      list = profiles || [];
      at = -1;
      const rows = list.map((u) => {
        const row = document.createElement('div');
        row.className = 'sg-row';
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.src = (u.avatar || '').replace(/-(large|crop|t\d+x\d+|badge|small|tiny|mini|original)\./, '-badge.');
        const text = document.createElement('div');
        text.className = 'sb-txt';
        const name = document.createElement('b');
        name.textContent = u.name;
        const sub = document.createElement('span');
        sub.textContent = `@${u.username} · ${fmt(u.followers)} followers`;
        text.append(name, sub);
        row.append(img, text);
        row.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so the click lands
        row.addEventListener('click', () => open(u));
        return row;
      });
      const foot = document.createElement('div');
      foot.className = 'sg-more';
      foot.textContent =
        profiles === null
          ? 'Searching SoundCloud…'
          : list.length
            ? `Open “${q}” directly ↵`
            : `No SoundCloud profile starts with “${q}”. Open it directly ↵`;
      if (profiles !== null) {
        foot.addEventListener('mousedown', (e) => e.preventDefault());
        foot.addEventListener('click', () => form.requestSubmit());
      }
      box.replaceChildren(...rows, foot);
      box.hidden = false;
    }

    function render() {
      clearTimeout(timer);
      const q = term();
      if (!q) return close();
      if (!list.length) show(q, null); // keep showing the last results rather than flashing
      const mine = ++token;
      timer = setTimeout(async () => {
        let found = [];
        try {
          const res = await fetch('/api/search?q=' + encodeURIComponent(q));
          if (res.ok) found = await res.json();
        } catch {
          /* treated as no results */
        }
        if (mine !== token) return; // typed something newer since
        const lq = q.toLowerCase();
        show(
          q,
          found
            .filter((u) => [u.name, u.username, u.fullName].some((s) => s && s.toLowerCase().startsWith(lq)))
            .sort((a, b) => b.followers - a.followers)
            .slice(0, SUGGESTIONS)
        );
      }, 180); // wait for a pause in typing
    }

    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!list.length) return;
        // cycles through the rows, with one extra stop (-1) meaning "nothing highlighted"
        at = ((at + 1 + (e.key === 'ArrowDown' ? 1 : -1) + list.length + 1) % (list.length + 1)) - 1;
        highlight();
      } else if (e.key === 'Enter' && at >= 0) {
        e.preventDefault(); // a highlighted person beats opening the typed username
        open(list[at]);
      } else if (e.key === 'Escape') {
        close();
      }
    });
    document.addEventListener('click', (e) => {
      if (!form.contains(e.target)) close();
    });

    return { close };
  };
})();
