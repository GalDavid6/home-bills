// Inline SVG line icons (stroke = currentColor), so the UI needs no emoji or icon font.
// window.icons.el(name, size) -> SVGElement; window.icons.str(name, size) -> markup for
// the few renderers that still build HTML strings (only static path data goes in it).
(function () {
  const PATHS = {
    home: ['M3 11l9-7 9 7', 'M5 10v10h14V10'],
    chart: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
    receipt: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6M9 12h6'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
    camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    close: ['M6 6l12 12M18 6L6 18'],
    back: ['M9 6l6 6-6 6'], // RTL: "back" points right
    next: ['M15 6l-6 6 6 6'], // RTL: "forward" points left
    link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
    doc: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6M10 17h6'],
    bolt: ['M13 3L5 14h6l-1 7 8-11h-6z'],
    drop: ['M12 3c4 5 6 8.5 6 11a6 6 0 0 1-12 0c0-2.5 2-6 6-11z'],
    copy: ['M9 9h11v11H9z', 'M5 15V4h11'],
    logout: ['M15 4h4v16h-4', 'M10 8l-4 4 4 4', 'M6 12h10'],
    bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
    send: ['M21 3L3 10.5l7 2.5 2.5 7z', 'M10 13l11-10'],
    edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
    photo: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 8.5a1 1 0 1 0 0 .1'],
    download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
    trash: ['M5 7h14', 'M9 7V4h6v3', 'M7 7l1 13h8l1-13'],
    alert: ['M12 8v5', 'M12 16.5v.5'],
    lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
    up: ['M12 19V5', 'M6 11l6-6 6 6'],
    down: ['M12 5v14', 'M6 13l6 6 6-6'],
    chevDown: ['M6 9l6 6 6-6'],
  };
  const NS = 'http://www.w3.org/2000/svg';

  function el(name, size = 18, strokeWidth = 1.9) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', strokeWidth);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    (PATHS[name] || []).forEach((d) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function str(name, size = 18, strokeWidth = 1.9) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
      (PATHS[name] || []).map((d) => `<path d="${d}"/>`).join('') + '</svg>';
  }

  window.icons = { el, str };
}());
