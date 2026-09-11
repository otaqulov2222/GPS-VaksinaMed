/**
 * Global delete micro-interaction: trash bin "eats" the label (GSAP).
 * Use ONLY on delete actions via VmEatDelete.markup / .play / .run
 */
(function (global) {
  'use strict';

  var LABEL = "Oʻchirish";
  var DONE_TEXT = "Oʻchirildi";

  function escAttr(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function splitLabel(el, text) {
    el.textContent = '';
    var chars = Array.from(text);
    var spans = [];
    for (var i = 0; i < chars.length; i++) {
      var span = document.createElement('span');
      span.className = 'eat-del__letter';
      span.textContent = chars[i] === ' ' ? '\u00a0' : chars[i];
      el.appendChild(span);
      spans.push(span);
    }
    return spans;
  }

  function ensureFx(btn) {
    var fx = btn.querySelector('.eat-del__fx');
    if (!fx) {
      fx = document.createElement('span');
      fx.className = 'eat-del__fx';
      btn.appendChild(fx);
    }
    fx.innerHTML = '';
    return fx;
  }

  function spawnSparks(fx, x, y, count) {
    var nodes = [];
    for (var i = 0; i < count; i++) {
      var s = document.createElement('span');
      s.className = 'eat-del__spark';
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      fx.appendChild(s);
      nodes.push(s);
    }
    return nodes;
  }

  function ensureParts(btn) {
    var label = btn.querySelector('.eat-del__label') || btn.querySelector('.ph-eat-del__label');
    if (!label) return null;
    var letters = label.querySelectorAll('.eat-del__letter, .ph-eat-del__letter');
    if (!letters.length) {
      letters = splitLabel(label, LABEL);
    } else {
      letters = Array.prototype.slice.call(letters);
    }
    return {
      btn: btn,
      icon: btn.querySelector('.eat-del__icon, .ph-eat-del__icon'),
      lid: btn.querySelector('.bin-lid'),
      body: btn.querySelector('.bin-body'),
      label: label,
      letters: letters,
      done: btn.querySelector('.eat-del__done, .ph-eat-del__done'),
      fx: ensureFx(btn)
    };
  }

  function mouthPoint(parts) {
    var icon = parts.icon.getBoundingClientRect();
    var btn = parts.btn.getBoundingClientRect();
    return {
      x: icon.left + icon.width * 0.52 - btn.left,
      y: icon.top + icon.height * 0.32 - btn.top
    };
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
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

      var hinge = '7px 5px';
      var targets = [parts.lid, parts.body, parts.btn, parts.icon].concat(parts.letters);
      gsap.killTweensOf(targets);
      gsap.set(parts.letters, { clearProps: 'all' });
      gsap.set([parts.lid, parts.body, parts.btn, parts.icon], { clearProps: 'transform' });
      if (parts.done) gsap.set(parts.done, { opacity: 0 });

      var mouth = mouthPoint(parts);
      var tl = gsap.timeline({
        defaults: { ease: 'power2.out' },
        onComplete: function () {
          btn.classList.remove('is-busy');
          btn.classList.add('is-done');
          if (parts.done) {
            gsap.fromTo(
              parts.done,
              { opacity: 0, scale: 0.75, y: 4 },
              { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.7)' }
            );
          }
          resolve();
        }
      });

      // 1) Anticipation — soft press
      tl.to(parts.btn, {
        scale: 0.97,
        duration: 0.12,
        ease: 'power2.in'
      }, 0);
      tl.to(parts.lid, {
        rotation: 6,
        y: 0.5,
        duration: 0.12,
        ease: 'power2.in',
        transformOrigin: hinge
      }, 0);

      // 2) Dramatic lid open — overshoot then settle
      tl.to(parts.btn, {
        scale: 1.04,
        duration: 0.38,
        ease: 'power2.out'
      }, 0.12);
      tl.to(parts.lid, {
        rotation: -62,
        y: -1,
        duration: 0.42,
        ease: 'back.out(2.4)',
        transformOrigin: hinge
      }, 0.12);
      tl.to(parts.icon, {
        rotation: -4,
        duration: 0.42,
        ease: 'power2.out'
      }, 0.12);
      // Settle lid slightly closed from overshoot
      tl.to(parts.lid, {
        rotation: -48,
        duration: 0.28,
        ease: 'sine.inOut',
        transformOrigin: hinge
      }, 0.5);
      tl.to(parts.btn, {
        scale: 1,
        duration: 0.28,
        ease: 'sine.out'
      }, 0.5);
      tl.to(parts.icon, {
        rotation: 0,
        duration: 0.28,
        ease: 'sine.out'
      }, 0.5);

      // Soft sparkle burst when lid opens
      tl.add(function () {
        var sparks = spawnSparks(parts.fx, mouth.x, mouth.y - 4, 6);
        sparks.forEach(function (sp, si) {
          var ang = (-Math.PI * 0.85) + si * 0.28;
          gsap.fromTo(
            sp,
            { opacity: 0.95, x: 0, y: 0, scale: 0.4 },
            {
              opacity: 0,
              x: Math.cos(ang) * gsap.utils.random(12, 26),
              y: Math.sin(ang) * gsap.utils.random(10, 22),
              scale: gsap.utils.random(0.2, 0.6),
              duration: 0.55,
              ease: 'power2.out'
            }
          );
        });
      }, 0.28);

      // 3) Letters pulled in — strong red attention
      parts.letters.forEach(function (letter, i) {
        var rect = letter.getBoundingClientRect();
        var btnRect = parts.btn.getBoundingClientRect();
        var fromX = rect.left + rect.width / 2 - btnRect.left;
        var fromY = rect.top + rect.height / 2 - btnRect.top;
        var dx = mouth.x - fromX;
        var dy = mouth.y - fromY;
        var t0 = 0.62 + i * 0.072;

        tl.to(letter, {
          color: '#b91c1c',
          scale: 1.12,
          duration: 0.08,
          ease: 'power1.out'
        }, t0);

        tl.to(letter, {
          x: dx * 0.5,
          y: dy - 16 - gsap.utils.random(0, 5),
          rotation: gsap.utils.random(-40, 40),
          scale: 0.78,
          duration: 0.18,
          ease: 'power2.in'
        }, t0 + 0.06);

        tl.to(letter, {
          x: dx,
          y: dy + 2,
          scale: 0,
          opacity: 0,
          rotation: gsap.utils.random(-100, 100),
          filter: 'blur(1.5px)',
          duration: 0.2,
          ease: 'power3.in'
        }, t0 + 0.2);

        tl.to(parts.body, {
          scaleY: 0.84,
          scaleX: 1.12,
          duration: 0.07,
          yoyo: true,
          repeat: 1,
          ease: 'power1.inOut',
          transformOrigin: 'center bottom'
        }, t0 + 0.26);

        // Subtle lid chomp per letter
        tl.to(parts.lid, {
          rotation: -42,
          duration: 0.06,
          yoyo: true,
          repeat: 1,
          ease: 'sine.inOut',
          transformOrigin: hinge
        }, t0 + 0.24);

        tl.add(function () {
          var sparks = spawnSparks(parts.fx, mouth.x, mouth.y, 3);
          sparks.forEach(function (sp, si) {
            var ang = (-Math.PI / 2) + (si - 1) * 0.5;
            gsap.fromTo(
              sp,
              { opacity: 1, x: 0, y: 0, scale: 1 },
              {
                opacity: 0,
                x: Math.cos(ang) * gsap.utils.random(8, 18),
                y: Math.sin(ang) * gsap.utils.random(6, 14),
                scale: 0,
                duration: 0.32,
                ease: 'power2.out'
              }
            );
          });
        }, t0 + 0.28);
      });

      var after = 0.72 + parts.letters.length * 0.072;

      // 4) Lid closes — elegant snap + elastic settle
      tl.to(parts.lid, {
        rotation: 10,
        duration: 0.18,
        ease: 'power3.in',
        transformOrigin: hinge
      }, after);
      tl.to(parts.lid, {
        rotation: 0,
        y: 0,
        duration: 0.55,
        ease: 'elastic.out(1.2, 0.4)',
        transformOrigin: hinge
      }, after + 0.16);

      tl.to(parts.body, {
        scaleX: 1.08,
        scaleY: 0.9,
        duration: 0.1,
        yoyo: true,
        repeat: 1,
        transformOrigin: 'center bottom'
      }, after + 0.14);

      tl.to(parts.btn, {
        boxShadow: '0 2px 12px rgba(5,150,105,0.2)',
        borderColor: '#a7f3d0',
        duration: 0.3
      }, after + 0.25);
    });
  }

  /**
   * Confirm → animate → callback. Prevents double-clicks.
   * @param {HTMLElement} btn
   * @param {{ confirm?: string|false, afterMs?: number, action: Function }} opts
   */
  async function run(btn, opts) {
    opts = opts || {};
    if (!btn || btn.classList.contains('is-busy') || btn.classList.contains('is-done')) return false;
    if (opts.confirm !== false) {
      var msg = typeof opts.confirm === 'string' ? opts.confirm : 'Oʻchirasizmi?';
      if (!global.confirm(msg)) return false;
    }
    try {
      await play(btn);
      await wait(opts.afterMs != null ? opts.afterMs : 380);
    } catch (_) { /* continue */ }
    if (typeof opts.action === 'function') {
      await opts.action();
    }
    return true;
  }

  /**
   * @param {Record<string,string>} attrs  e.g. { 'data-ph-del': id, className: 'j-del eat-del--sm' }
   */
  function markup(attrs) {
    attrs = Object.assign({}, attrs || {});
    var extra = String(attrs.className || attrs.class || '').trim();
    delete attrs.className;
    delete attrs.class;

    var attrStr = '';
    Object.keys(attrs).forEach(function (k) {
      attrStr += ' ' + k + '="' + escAttr(attrs[k]) + '"';
    });

    var cls = ('eat-del' + (extra ? ' ' + extra : '')).trim();

    return (
      '<button type="button" class="' + cls + '"' + attrStr + ' aria-label="' + LABEL + '">' +
      '<span class="eat-del__icon" aria-hidden="true">' +
      '<svg class="eat-del__svg" viewBox="0 0 24 24">' +
      '<g class="bin-lid">' +
      '<line x1="7.5" y1="5.2" x2="16.5" y2="5.2"/>' +
      '<path d="M9.2 5.2 V4.1 a1.3 1.3 0 0 1 1.3-1.2 h3 a1.3 1.3 0 0 1 1.3 1.2 V5.2"/>' +
      '</g>' +
      '<g class="bin-body">' +
      '<path d="M7.4 7.3 h9.2 l-0.75 12 a1.5 1.5 0 0 1-1.5 1.35 H9.65 a1.5 1.5 0 0 1-1.5-1.35 Z"/>' +
      '<line x1="10.2" y1="10.1" x2="10.2" y2="16.6"/>' +
      '<line x1="12" y1="10.1" x2="12" y2="16.6"/>' +
      '<line x1="13.8" y1="10.1" x2="13.8" y2="16.6"/>' +
      '</g>' +
      '</svg></span>' +
      '<span class="eat-del__label">' + LABEL + '</span>' +
      '<span class="eat-del__fx" aria-hidden="true"></span>' +
      '<span class="eat-del__done" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M5 13 l4 4 L19 7"/></svg>' +
      DONE_TEXT +
      '</span></button>'
    );
  }

  var api = { play: play, run: run, markup: markup, LABEL: LABEL, wait: wait };
  global.VmEatDelete = api;
  global.PhEatDelete = api; // backward compat
})(typeof window !== 'undefined' ? window : this);
