(() => {
  const productPattern = /\b(?:NEXO|GENTIA)\b/gi;

  function rgbIsDark(value) {
    const match = String(value || '').match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
    if (!match) return false;
    const [, red, green, blue] = match.map(Number);
    return (red * 299 + green * 587 + blue * 114) / 1000 < 145;
  }

  function sitsOnDarkSurface(element) {
    let current = element;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if (style.backgroundColor && !style.backgroundColor.endsWith(', 0)') && style.backgroundColor !== 'transparent') {
        return rgbIsDark(style.backgroundColor);
      }
      current = current.parentElement;
    }
    return false;
  }

  function brandStandaloneHeaders(root = document) {
    root.querySelectorAll?.('.brand:not(.gentia-brand)').forEach((brand) => {
      if (!productPattern.test(brand.textContent || '')) return;
      productPattern.lastIndex = 0;
      const image = document.createElement('img');
      image.src = sitsOnDarkSurface(brand) ? '/gentia-wordmark-reversed.svg' : '/gentia-wordmark.svg';
      image.alt = 'GENTIA';
      brand.replaceChildren(image);
      brand.classList.add('gentia-brand', 'gentia-brand-runtime');
      brand.setAttribute('aria-label', 'GENTIA');
    });
    productPattern.lastIndex = 0;
  }

  function updateStaticProductCopy(root = document) {
    const selectors = ['footer', '.document-footer', '.pdf-footer'];
    root.querySelectorAll?.(selectors.join(',')).forEach((container) => {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        if (/NEXO ERP/i.test(node.nodeValue || '')) node.nodeValue = node.nodeValue.replace(/NEXO ERP/gi, 'GENTIA ERP');
      });
    });
  }

  function applyBrand() {
    document.title = document.title.replace(/\bNEXO\b/gi, 'GENTIA');
    brandStandaloneHeaders();
    updateStaticProductCopy();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyBrand, { once: true });
  else applyBrand();
})();
