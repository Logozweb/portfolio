document.addEventListener('DOMContentLoaded', () => {
  const y = document.getElementById('year'); if (y) y.textContent = String(new Date().getFullYear());

  // Theme toggle
  const key = 'theme-preference';
  const root = document.body;
  const saved = localStorage.getItem(key);
  if (saved === 'light') root.setAttribute('data-theme','light'); else if (saved === 'dark') root.removeAttribute('data-theme');
  const themeBtns = document.querySelectorAll('.themeToggleBtn');
  const syncIcons = () => {
    const isLight = root.getAttribute('data-theme') === 'light';
    themeBtns.forEach(btn => {
      const sun = btn.querySelector('.sun'); const moon = btn.querySelector('.moon');
      if (sun) sun.style.opacity = isLight ? '0.6' : '0.95';
      if (moon) moon.style.opacity = isLight ? '0.95' : '0.6';
      btn.setAttribute('aria-pressed', String(isLight));
    });
  };
  syncIcons();
  themeBtns.forEach(btn => btn.addEventListener('click', () => {
    const isLight = root.getAttribute('data-theme') === 'light';
    if (isLight) { root.removeAttribute('data-theme'); localStorage.setItem(key,'dark'); }
    else { root.setAttribute('data-theme','light'); localStorage.setItem(key,'light'); }
    syncIcons();
  }));

  // Scroll spy for content nav and sidebar nav
  const links = document.querySelectorAll('.nav a, .content-nav a');
  links.forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault(); const id = a.getAttribute('href'); const target = document.querySelector(id);
    if (!target) return; target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    links.forEach(l => l.classList.remove('active')); a.classList.add('active');
  }));
  const obs = new IntersectionObserver((entries)=>{
    entries.forEach(en => {
      if (!en.isIntersecting) return; const id = '#' + en.target.id;
      links.forEach(l => l.classList.toggle('active', l.getAttribute('href') === id));
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0.01 });
  document.querySelectorAll('section[id]').forEach(s => obs.observe(s));

  // Reveal-on-scroll animations
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (revealEls.length) {
    const revealObs = new IntersectionObserver((entries) => {
      entries.forEach(({ isIntersecting, target }) => {
        if (!isIntersecting) return;
        target.classList.add('is-visible');
        revealObs.unobserve(target);
      });
    }, { threshold: 0.15 });
    revealEls.forEach(el => revealObs.observe(el));
  }

  // Animated counters (start when visible)
  (function(){
    const runCounter = (el) => {
      if (el.getAttribute('data-animated') === 'true') return;
      const target = el.getAttribute('data-counter') || '0';
      const number = parseInt(target, 10) || 0;
      const suffix = target.replace(String(number), '');
      let current = 0;
      const durationMs = 1200;
      const start = performance.now();
      el.setAttribute('data-animated', 'true');
      const tick = (now) => {
        const t = Math.min(1, (now - start) / durationMs);
        current = Math.round(number * (0.5 - Math.cos(Math.PI * t) / 2));
        el.textContent = current + suffix;
        if (t < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const counters = document.querySelectorAll('[data-counter]');
    const io = new IntersectionObserver((entries) => {
      entries.forEach(({ isIntersecting, target }) => { if (isIntersecting) runCounter(target); });
    }, { threshold: 0.35 });
    counters.forEach(el => io.observe(el));
    counters.forEach(el => { const rect = el.getBoundingClientRect(); if (rect.top >= 0 && rect.top < window.innerHeight) runCounter(el); });
  })();

  // Works fetch/filter/paginate
  const filterBtns = document.querySelectorAll('.filter-btn');
  const grid = document.getElementById('workGrid');
  const emptyState = document.getElementById('workEmpty');
  const pager = document.getElementById('workPagination');
  let worksCache = []; let currentFilter = 'all'; let currentPage = 1; const pageSize = 4;
  const sliceForPage = (list) => list.slice((currentPage-1)*pageSize, (currentPage-1)*pageSize + pageSize);
  function renderPagination(total){
    if (!pager) return; const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages === 1) { pager.innerHTML = ''; return; }
    pager.innerHTML = Array.from({ length: totalPages }, (_, i) => {
      const n = i + 1; const active = n === currentPage ? 'is-active' : '';
      return `<button class="${active}" data-page="${n}" aria-label="Page ${n}">${n}</button>`;
    }).join('');
    pager.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
      currentPage = parseInt(btn.getAttribute('data-page')||'1', 10); applyRender(); grid && grid.scrollIntoView({ behavior:'smooth', block:'start' });
    }));
  }
  function renderWorks(list){
    if (!grid) return; const pageList = sliceForPage(list);
    grid.innerHTML = pageList.map(w => `
      <article class="work-card" data-cat="${w.category}">
        <img src="${w.image_path}" alt="${w.title}" />
        <div class="work-body">
          <div class="work-title">${w.title}</div>
          <div class="work-tags"><span class="tag">${(w.category||'').toUpperCase()}</span></div>
          ${w.live_url ? `<a class="view-btn" href="${w.live_url}" target="_blank" rel="noopener">See Live Project (If Available)</a>` : ''}
        </div>
      </article>`).join('');
    if (emptyState) emptyState.style.display = list.length ? 'none' : '';
    renderPagination(list.length);
  }
  function applyRender(){
    let list;
    if (currentFilter === 'all') {
      // For "All" tab, create a shuffled copy of worksCache
      list = [...worksCache]; // Create a copy to avoid modifying original
      // Fisher-Yates shuffle algorithm for random ordering
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]]; // Swap elements
      }
    } else {
      // For specific categories, filter normally
      list = worksCache.filter(w => w.category === currentFilter);
    }
    
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize)); 
    if (currentPage > totalPages) currentPage = 1;
    renderWorks(list);
  }
  async function loadWorks(){
    try { const res = await fetch('/api/works'); worksCache = await res.json(); applyRender(); } catch(_){}
  }
  filterBtns.forEach(btn => btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active')); 
    btn.classList.add('active');
    currentFilter = btn.getAttribute('data-filter') || 'all'; 
    currentPage = 1; 
    
    // Show/hide the random note based on active filter
    const randomNote = document.getElementById('randomNote');
    if (randomNote) {
      randomNote.style.display = currentFilter === 'all' ? 'block' : 'none';
    }
    
    // If switching to "All" tab, show a subtle loading effect
    if (currentFilter === 'all' && grid) {
      grid.style.opacity = '0.6';
      grid.style.transition = 'opacity 0.3s ease';
      
      // Apply render and restore opacity
      setTimeout(() => {
        applyRender();
        grid.style.opacity = '1';
      }, 150);
    } else {
      applyRender();
    }
  }));
  if (grid) loadWorks();

  // Formspree form handling
  var form = document.getElementById("my-form");
  
  async function handleSubmit(event) {
    event.preventDefault();
    var status = document.getElementById("my-form-status");
    var data = new FormData(event.target);
    fetch(event.target.action, {
      method: form.method,
      body: data,
      headers: {
          'Accept': 'application/json'
      }
    }).then(response => {
      if (response.ok) {
        status.innerHTML = "Thanks for your submission!";
        form.reset()
      } else {
        response.json().then(data => {
          if (Object.hasOwn(data, 'errors')) {
            status.innerHTML = data["errors"].map(error => error["message"]).join(", ")
          } else {
            status.innerHTML = "Oops! There was a problem submitting your form"
          }
        })
      }
    }).catch(error => {
      status.innerHTML = "Oops! There was a problem submitting your form"
    });
  }
  form.addEventListener("submit", handleSubmit)

  // Piano ambience toggle (sidebar icon + nav button)
  const pianoButtons = Array.from(document.querySelectorAll('#pianoToggle, #pianoToggleNav'));
  let pianoAudio;
  if (pianoButtons.length) {
    pianoAudio = new Audio('assets/audio/piano.mp3');
    pianoAudio.loop = true;
    pianoAudio.volume = 0.18;

    const updateButtons = (isPlaying) => {
      pianoButtons.forEach((btn) => {
        btn.setAttribute('data-playing', String(isPlaying));
        btn.setAttribute('aria-pressed', String(isPlaying));
        if (btn.id === 'pianoToggle') {
          // Sidebar icon button
          btn.title = isPlaying ? 'Pause piano ambience' : 'Play piano ambience';
          btn.setAttribute('aria-label', btn.title);
        } else if (btn.id === 'pianoToggleNav') {
          // Nav text button
          btn.textContent = isPlaying ? 'Pause Piano' : 'Do you Love Piano?';
        }
      });
    };

    const togglePiano = () => {
      const isPlaying = pianoButtons[0].getAttribute('data-playing') === 'true';
      if (isPlaying) {
        pianoAudio.pause();
        updateButtons(false);
      } else {
        pianoAudio.play().then(() => {
          updateButtons(true);
        }).catch(() => {
          updateButtons(false);
        });
      }
    };

    pianoButtons.forEach((btn) => {
      btn.addEventListener('click', togglePiano);
    });
  }

  // Testimonials carousel
  const slides = document.querySelectorAll('.testimonial-slide');
  const prevBtn = document.getElementById('testimonialPrev');
  const nextBtn = document.getElementById('testimonialNext');
  const dotsWrap = document.getElementById('testimonialDots');
  if (slides.length) {
    let current = 0;
    const createDots = () => {
      if (!dotsWrap) return;
      dotsWrap.innerHTML = '';
      slides.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.setAttribute('aria-label', `Go to testimonial ${i + 1}`);
        dot.style.width = '8px';
        dot.style.height = '8px';
        dot.style.borderRadius = '999px';
        dot.style.border = 'none';
        dot.style.cursor = 'pointer';
        dot.style.padding = '0';
        dot.dataset.index = String(i);
        dotsWrap.appendChild(dot);
      });
    };
    const update = () => {
      slides.forEach((el, i) => {
        el.style.display = i === current ? 'block' : 'none';
      });
      if (dotsWrap) {
        dotsWrap.querySelectorAll('button').forEach((dot, i) => {
          dot.style.opacity = i === current ? '1' : '0.4';
          dot.style.background = i === current ? 'var(--accent, #3b82f6)' : 'var(--muted, #64748b)';
        });
      }
    };
    createDots();
    update();
    prevBtn && prevBtn.addEventListener('click', () => {
      current = (current - 1 + slides.length) % slides.length;
      update();
    });
    nextBtn && nextBtn.addEventListener('click', () => {
      current = (current + 1) % slides.length;
      update();
    });
    if (dotsWrap) {
      dotsWrap.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const idx = t.dataset.index;
        if (!idx) return;
        current = parseInt(idx, 10) || 0;
        update();
      });
    }
    // Auto-advance every 10 seconds
    setInterval(() => {
      current = (current + 1) % slides.length;
      update();
    }, 10000);
  }
});