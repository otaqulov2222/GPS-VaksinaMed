/**
 * Pharmacy-only delete micro-interaction: trash bin "eats" the label.
 * Depends on GSAP (window.gsap). Scoped to .ph-eat-del buttons.
 */
(function (global) {
  'use strict';

  var LABEL = "Oʻchirish";
  var DONE_TEXT = "Oʻchirildi";

  function splitLabel(el, text) {
    el.textContent = '';
    var chars = Array.from(text);
    var spans = [];
    for (var i = 0; i < chars.length; i++) {
      var span = document.createElement('span');
      span.className = 'ph-eat-del__letter';
      span.textContent = chars[i] === ' ' ? '\u00a0' : chars[i];
      el.appendChild(span);
      spans.push(span);
    }
    return spans;
  }

  function ensureParts(btn) {
    var label = btn.querySelector('.ph-eat-del__label');
    if (!label) return null;
    var letters = label.querySelectorAll('.ph-eat-del__letter');
    if (!letters.length) {
      letters = splitLabel(label, LABEL);
    } else {
      letters = Array.prototype.slice.call(letters);
    }
    return {
      btn: btn,
      icon: btn.querySelector('.ph-eat-del__icon'),
      svg: btn.querySelector('.ph-eat-del__svg'),
      lid: btn.querySelector('.bin-lid'),
      body: btn.querySelector('.bin-body'),
      label: label,
      letters: letters,
      done: btn.querySelector('.ph-eat-del__done')
    };
  }

  function mouthPoint(parts) {
    var icon = parts.icon.getBoundingClientRect();
    var btn = parts.btn.getBoundingClientRect();
    return {
      x: icon.left + icon.width * 0.5 - btn.left,
      y: icon.top + icon.height * 0.35 - btn.top
    };
  }

  /**
   * Play eat animation. Resolves when finished (or immediately if GSAP missing).
   * @param {HTMLElement} btn
   * @returns {Promise<void>}
   */
  function play(btn) {
    return new Promise(function (resolve) {
      if (!btn || btn.classList.contains('is-busy')) {
        resolve();
        return;
      }

      var gsap = global.gsap;
      var parts = ensureParts(btn);
      if (!parts) {
        resolve();
        return;
      }

      btn.classList.remove('is-done');
      btn.classList.add('is-busy');

      if (!gsap) {
        btn.classList.remove('is-busy');
        btn.classList.add('is-done');
        resolve();
        return;
      }

      gsap.killTweensOf([parts.lid, parts.body].concat(parts.letters));
      gsap.set(parts.letters, { clearProps: 'all' });
      gsap.set([parts.lid, parts.body], { clearProps: 'transform' });
      if (parts.done) gsap.set(parts.done, { opacity: 0 });

      var mouth = mouthPoint(parts);
      var tl = gsap.timeline({
        defaults: { ease: 'power2.out' },
        onComplete: function () {
          btn.classList.remove('is-busy');
          btn.classList.add('is-done');
          if (parts.done) {
            gsap.to(parts.done, { opacity: 1, duration: 0.25 });
          }
          resolve();
        }
      });

      // Lid opens
      tl.to(parts.lid, {
        rotation: -38,
        duration: 0.28,
        ease: 'back.out(1.6)',
        transformOrigin: '12px 5px'
      });

      // Letters inhale L→R
      parts.letters.forEach(function (letter, i) {
        var rect = letter.getBoundingClientRect();
        var btnRect = parts.btn.getBoundingClientRect();
        var fromX = rect.left + rect.width / 2 - btnRect.left;
        var fromY = rect.top + rect.height / 2 - btnRect.top;
        var dx = mouth.x - fromX;
        var dy = mouth.y - fromY - 4;

        tl.to(
          letter,
          {
            x: dx,
            y: dy - 10,
            rotation: gsap.utils.random(-40, 40),
            scale: 0.55,
            duration: 0.18,
            ease: 'power1.in'
          },
          0.22 + i * 0.07
        );
        tl.to(
          letter,
          {
            x: dx,
            y: dy + 2,
            scale: 0,
            opacity: 0,
            rotation: gsap.utils.random(-90, 90),
            duration: 0.16,
            ease: 'power2.in'
          },
          0.34 + i * 0.07
        );
        // Bin chomp / jiggle per letter
        tl.to(
          parts.body,
          {
            scaleY: 0.88,
            scaleX: 1.08,
            duration: 0.07,
            yoyo: true,
            repeat: 1,
            transformOrigin: 'center bottom'
          },
          0.38 + i * 0.07
        );
      });

      var after = 0.42 + parts.letters.length * 0.07;

      // Lid snaps shut
      tl.to(
        parts.lid,
        {
          rotation: 0,
          duration: 0.35,
          ease: 'elastic.out(1, 0.55)',
          transformOrigin: '12px 5px'
        },
        after
      );
      tl.to(
        parts.body,
        {
          scaleX: 1.06,
          scaleY: 0.94,
          duration: 0.12,
          yoyo: true,
          repeat: 1,
          transformOrigin: 'center bottom'
        },
        after
      );
    });
  }

  /** Markup helper for pharmacy rows */
  function markup(id) {
    var safe = String(id == null ? '' : id)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    return (
      '<button type="button" class="ph-eat-del" data-ph-del="' +
      safe +
      '" aria-label="' +
      LABEL +
      '">' +
      '<span class="ph-eat-del__icon" aria-hidden="true">' +
      '<svg class="ph-eat-del__svg" viewBox="0 0 24 24">' +
      '<g class="bin-lid">' +
      '<line x1="8" y1="5" x2="16" y2="5"/>' +
      '<path d="M9 5 V4.2 a1.2 1.2 0 0 1 1.2-1.2 h3.6 A1.2 1.2 0 0 1 15 4.2 V5"/>' +
      '</g>' +
      '<g class="bin-body">' +
      '<path d="M7.5 7.2 h9 l-0.7 12.2 a1.4 1.4 0 0 1-1.4 1.3 H9.6 a1.4 1.4 0 0 1-1.4-1.3 Z"/>' +
      '<line x1="10.2" y1="10" x2="10.2" y2="16.5"/>' +
      '<line x1="12" y1="10" x2="12" y2="16.5"/>' +
      '<line x1="13.8" y1="10" x2="13.8" y2="16.5"/>' +
      '</g>' +
      '</svg>' +
      '</span>' +
      '<span class="ph-eat-del__label">' +
      LABEL +
      '</span>' +
      '<span class="ph-eat-del__done" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M5 13 l4 4 L19 7"/></svg>' +
      DONE_TEXT +
      '</span>' +
      '</button>'
    );
  }

  global.PhEatDelete = { play: play, markup: markup, LABEL: LABEL };
})(typeof window !== 'undefined' ? window : this);
