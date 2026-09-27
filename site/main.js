// Comparsa sobria degli elementi, download consigliato in base al computer, versione dalla release.
(() => {
  document.documentElement.classList.add('js');

  // --- comparsa allo scorrimento ------------------------------------------------
  const items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach((el, i) => {
      // piccolo sfasamento tra elementi vicini (es. le quattro schede dei passaggi)
      const siblings = el.parentElement ? [...el.parentElement.children].filter((c) => c.classList.contains('reveal')) : [];
      const idx = siblings.indexOf(el);
      if (idx > 0 && siblings.length > 2) el.style.transitionDelay = `${Math.min(idx, 5) * 70}ms`;
      io.observe(el);
    });
  } else {
    items.forEach((el) => el.classList.add('in'));
  }

  // --- piattaforma del visitatore ---------------------------------------------
  const LABELS = {
    'mac-arm': 'Scarica per Mac',
    'mac-intel': 'Scarica per Mac (Intel)',
    win: 'Scarica per Windows',
    linux: 'Scarica per Linux',
  };

  async function detect() {
    const ua = navigator.userAgent;
    const uad = navigator.userAgentData;
    const platform = (uad && uad.platform) || navigator.platform || '';
    if (/win/i.test(platform) || /Windows/.test(ua)) return 'win';
    if (/mac/i.test(platform) || /Mac OS X/.test(ua)) {
      if (/iPhone|iPad/.test(ua)) return null;
      // i browser Chromium dicono l'architettura; Safari no: la maggior parte dei Mac recenti è Apple Silicon
      if (uad && uad.getHighEntropyValues) {
        try {
          const { architecture } = await uad.getHighEntropyValues(['architecture']);
          if (architecture === 'x86') return 'mac-intel';
        } catch {
          // informazione non disponibile
        }
      }
      return 'mac-arm';
    }
    if (/Android/.test(ua)) return null;
    if (/linux/i.test(platform) || /Linux|X11/.test(ua)) return 'linux';
    return null;
  }

  detect().then((p) => {
    if (!p) return;
    const card = document.querySelector(`.dl[data-platform="${p}"]`);
    if (!card) return;
    card.classList.add('recommended');
    // la scheda consigliata va per prima
    card.parentElement.prepend(card);
    const primary = document.querySelector('[data-primary-download]');
    if (primary) {
      primary.textContent = LABELS[p];
      primary.href = card.href;
    }
  });

  // --- versione pubblicata -----------------------------------------------------
  const versionEl = document.querySelector('[data-version]');
  if (versionEl && window.fetch) {
    fetch('https://api.github.com/repos/basoxxx/Virtual-Dj-Ai/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        if (!rel || !rel.tag_name) return;
        const date = new Date(rel.published_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
        versionEl.textContent = `Versione ${rel.tag_name.replace(/^v/, '')} · pubblicata il ${date}.`;
      })
      .catch(() => {});
  }
})();
