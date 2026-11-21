/* A guest's request as a look: a design with the guest's colors and message. Shared by tree-show (what the tree plays)
 * and the guest page (its preview), so both show the same thing.
 *   colors: [] = the design's own colors; [c] or [c1, c2] = those colors on both decks and the topper
 *   msg: '' = no words; else the words scroll across the tree, with the design's animation in the space below
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuestLook = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var NO_FILL = { text: 1, image: 1, graphic: 1, parade: 1 };
  function lum(h) { h = String(h || '#000000'); return 0.3 * parseInt(h.substr(1, 2), 16) + 0.59 * parseInt(h.substr(3, 2), 16) + 0.11 * parseInt(h.substr(5, 2), 16) || 0; }
  function guestLook(look, colors, msg) {
    var L = JSON.parse(JSON.stringify(look || {}));
    delete L.img;
    colors = (colors || []).filter(function (c) { return /^#[0-9a-f]{6}$/i.test(c); });
    if (colors.length) {
      var c = [colors[0], colors[1] || colors[0]];
      ['A', 'B'].forEach(function (k) { if (L[k]) { L[k].c = c.slice(); L[k].cl = false; } });
      L.tc = c.slice();
    }
    if (msg) {
      var A = L.A || { p: 'twinkle', c: ['#200000', '#ffffff'] };
      var below = A.p && !NO_FILL[A.p] ? A.p : 'twinkle';
      var deck = JSON.parse(JSON.stringify(A));
      deck.p = 'text'; deck.text = String(msg); deck.below = below; deck.sp = 1;
      // the letters are color 2: make sure they're bright enough to read (else swap, or white letters)
      var cc = deck.c || ['#200000', '#ffffff'], l0 = lum(cc[0]), l1 = lum(cc[1]);
      if (l1 < 90) deck.c = l0 >= 90 ? [cc[1], cc[0]] : [cc[0], '#ffffff'];
      L = { A: deck, B: L.B || deck, xf: 0, auto: 0, bpm: L.bpm || 120, top: L.top || 'star', tc: L.tc, strict: L.strict };
    }
    return L;
  }
  return { guestLook: guestLook };
});
