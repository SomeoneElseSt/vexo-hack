// Body-part figure for the records log: the mannequin silhouette with the
// reported region marked, so "chest" shows a chest and "hand" shows a hand,
// and an unknown location just shows the whole body with nothing marked.
'use strict';

(function () {
  // Mannequin in a 100 x 200 viewBox. Every marker coordinate below is taken
  // from these exact shapes (bboxes in the comment), so the dot always lands
  // on the drawn body:
  //   head    circle  center (50, 20) r 15           -> y 5 .. 35
  //   neck    rect    44,35  12 x 10
  //   torso   rect    32,45  36 x 48                  -> x 32 .. 68, y 45 .. 93
  //   arms    rects   22,45  10 x 60  and  68,45      -> centers (27, 75) / (73, 75)
  //   hips    rect    36,93  28 x 34
  //   legs    rects   38,127 11 x 70  and  51,127     -> centers (43.5, 162) / (56.5, 162)
  const FIGURE = `
    <circle cx="50" cy="20" r="15" />
    <rect x="44" y="35" width="12" height="10" />
    <rect x="32" y="45" width="36" height="48" />
    <rect x="22" y="45" width="10" height="60" rx="5" />
    <rect x="68" y="45" width="10" height="60" rx="5" />
    <rect x="36" y="93" width="28" height="34" />
    <rect x="38" y="127" width="11" height="70" rx="5" />
    <rect x="51" y="127" width="11" height="70" rx="5" />`;

  const REGIONS = {
    head: { words: ['head', 'face', 'eye', 'ear', 'nose', 'mouth', 'throat', 'neck', 'jaw', 'teeth', 'migraine'], at: [50, 20] },
    chest: { words: ['chest', 'heart', 'lung', 'breast', 'rib'], at: [50, 58] },
    stomach: { words: ['stomach', 'abdomen', 'belly', 'gut', 'nausea'], at: [50, 82] },
    back: { words: ['back', 'spine', 'lower back', 'shoulder blade'], at: [50, 70], hollow: true },
    arm: { words: ['arm', 'elbow', 'wrist', 'hand', 'finger', 'palm', 'shoulder'], at: [27, 75], mirror: true },
    leg: { words: ['leg', 'knee', 'thigh', 'shin', 'calf', 'foot', 'ankle', 'toe', 'hip'], at: [43.5, 162], mirror: true },
  };

  function regionOf(location) {
    const text = String(location || '').toLowerCase();
    if (!text) return null;
    for (const [key, region] of Object.entries(REGIONS)) {
      if (region.words.some((w) => text.includes(w))) {
        return { key, at: region.at, mirror: !!region.mirror, hollow: !!region.hollow };
      }
    }
    return null;
  }

  function marker(at, soft) {
    const cls = soft ? ' fig-mark-soft' : '';
    return `
      <circle cx="${at[0]}" cy="${at[1]}" r="6" class="fig-mark${cls}" />
      <circle cx="${at[0]}" cy="${at[1]}" r="2.6" class="fig-mark-core${cls}" />`;
  }

  function bodyFigure(location) {
    const region = regionOf(location);
    let marks = '';
    if (region) {
      marks = marker(region.at);
      // limbs exist twice, so the other side gets a faint dot too: the marker
      // never looks like it sits on one arbitrary side
      if (region.mirror) marks += marker([100 - region.at[0], region.at[1]], true);
    }
    const label = region ? 'marked: ' + location : location ? 'location not mapped' : 'no location given';
    return `
      <svg class="body" viewBox="0 0 100 200" role="img" aria-label="${label}">
        <g class="fig">${FIGURE}</g>
        ${marks}
      </svg>`;
  }

  window.vexoBody = { bodyFigure, regionOf };
})();
