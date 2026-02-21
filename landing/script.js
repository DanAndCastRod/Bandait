/* ================================================================
 *  BANDAIT LANDING — Interactive Logic
 *  Service Manual Entry: JS-LAND-001
 *  Handles: Scroll reveals, beat border effect, mobile nav
 * ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
    // --- SCROLL REVEAL (Intersection Observer) ---
    const revealElements = document.querySelectorAll('.reveal');
    const revealObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    revealObserver.unobserve(entry.target);
                }
            });
        },
        { threshold: 0.15, rootMargin: '0px 0px -50px 0px' }
    );

    revealElements.forEach((el) => revealObserver.observe(el));

    // --- MOBILE NAV TOGGLE ---
    const navToggle = document.getElementById('navToggle');
    const navLinks = document.getElementById('navLinks');

    if (navToggle && navLinks) {
        navToggle.addEventListener('click', () => {
            navLinks.classList.toggle('open');
            const isOpen = navLinks.classList.contains('open');
            navToggle.setAttribute('aria-label', isOpen ? 'Cerrar menú' : 'Abrir menú');
        });

        // Close nav when a link is clicked
        navLinks.querySelectorAll('a').forEach((link) => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('open');
            });
        });
    }

    // --- BEAT BORDER EFFECT (Visual Metronome Simulation) ---
    // BPM: 120 → 500ms per beat. Simulates the "El Marco" screen-edge flash.
    const beatBorder = document.getElementById('beatBorder');
    const BPM = 120;
    const beatInterval = 60000 / BPM;
    let beatCount = 0;

    function flashBeat() {
        if (!beatBorder) return;
        beatCount++;
        const isBeat1 = beatCount % 4 === 1;

        beatBorder.style.background = isBeat1 ? '#00FFFF' : '#333333';
        beatBorder.style.height = isBeat1 ? '4px' : '2px';
        beatBorder.classList.add('flash');

        setTimeout(() => {
            beatBorder.classList.remove('flash');
        }, 80);
    }

    setInterval(flashBeat, beatInterval);

    // --- HEADER SCROLL EFFECT ---
    const header = document.getElementById('siteHeader');
    let lastScroll = 0;

    window.addEventListener('scroll', () => {
        const currentScroll = window.scrollY;
        if (header) {
            if (currentScroll > 100) {
                header.style.borderBottomColor = currentScroll > lastScroll ? 'transparent' : '#333';
            } else {
                header.style.borderBottomColor = '#333';
            }
        }
        lastScroll = currentScroll;
    }, { passive: true });
});
