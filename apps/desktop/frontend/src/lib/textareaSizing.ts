export function autoSizeTextarea(node: HTMLTextAreaElement, value: string) {
  let width = -1;
  let disposed = false;
  let frame = 0;
  function resize() {
    if (disposed) return;
    const style = getComputedStyle(node);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    node.style.overflowY = 'hidden';
    node.style.height = '0px';
    const contentHeight = node.scrollHeight + border;
    node.style.height = `${contentHeight}px`;
    node.style.overflowY = node.scrollHeight > node.clientHeight + 1 ? 'auto' : 'hidden';
  }
  function schedule() {
    queueMicrotask(resize);
  }
  const observer = new ResizeObserver(entries => {
    const next = entries[0]?.contentRect.width ?? 0;
    if (next === width) return;
    width = next;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(resize);
  });
  observer.observe(node);
  node.addEventListener('input', resize);
  window.addEventListener('resize', resize);
  void value;
  schedule();
  return {
    update(next: string) {
      void next;
      schedule();
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      node.removeEventListener('input', resize);
      window.removeEventListener('resize', resize);
    },
  };
}
