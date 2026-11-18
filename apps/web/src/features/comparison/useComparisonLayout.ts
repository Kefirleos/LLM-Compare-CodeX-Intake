import { useLayoutEffect, useRef } from 'react';

const easing = 'cubic-bezier(.22, 1, .36, 1)';

function followAnswerScroll(scroll: HTMLElement, motion: MediaQueryList) {
  let enabled = true;
  let frame = 0;
  let target = scroll.scrollTop;
  let lastPosition = target;
  let previousTime = 0;

  function move(time: number) {
    frame = 0;
    const end = Math.min(target, scroll.scrollHeight - scroll.clientHeight);
    const distance = end - scroll.scrollTop;
    if (distance <= 0) return;

    // Ease toward the current end without restarting the animation for each new line.
    const elapsed = previousTime ? Math.min(time - previousTime, 32) : 16;
    const step = motion.matches || distance <= 2 ? distance : Math.max(1, distance * (1 - Math.exp(-elapsed / 70)));
    scroll.scrollTop += step;
    lastPosition = scroll.scrollTop;
    previousTime = time;
    if (end - lastPosition > 1) frame = requestAnimationFrame(move);
  }

  function pause() {
    enabled = false;
    cancelAnimationFrame(frame);
    frame = 0;
    scroll.style.removeProperty('overflow-anchor');
  }

  function onScroll() {
    const position = scroll.scrollTop;
    const atBottom = scroll.scrollHeight - scroll.clientHeight - position <= 1;
    if (position < lastPosition - 1 && !atBottom) pause();
    lastPosition = position;
  }

  function onWheel(event: WheelEvent) {
    if (event.deltaY < 0 && !event.ctrlKey) pause();
  }

  scroll.style.setProperty('overflow-anchor', 'none');
  scroll.addEventListener('scroll', onScroll, { passive: true });
  scroll.addEventListener('wheel', onWheel, { passive: true });
  scroll.addEventListener('pointerdown', pause);
  scroll.addEventListener('focusin', pause);

  return {
    get enabled() { return enabled; },
    moveTo(top: number) {
      if (!enabled) return;
      target = top;
      if (!frame && target - scroll.scrollTop > 1) {
        previousTime = 0;
        frame = requestAnimationFrame(move);
      }
    },
    dispose() {
      pause();
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('wheel', onWheel);
      scroll.removeEventListener('pointerdown', pause);
      scroll.removeEventListener('focusin', pause);
    },
  };
}

export function useComparisonLayout(turnId: string | undefined) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousComposer = useRef<DOMRect | null>(null);
  const submittedTurn = useRef<string | null>(null);
  const scheduleMeasure = useRef<(() => void) | null>(null);

  function prepareTransition(nextTurnId: string) {
    if (!turnId) previousComposer.current = workspaceRef.current?.querySelector('.composer')?.getBoundingClientRect() ?? null;
    submittedTurn.current = nextTurnId;
  }

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const viewport = workspace?.querySelector<HTMLElement>('.comparison-viewport');
    const scroll = viewport?.querySelector<HTMLElement>('.comparison-scroll');
    const content = scroll?.querySelector<HTMLElement>('.comparison-content');
    if (!workspace || !viewport || !scroll || !content || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    let animation: Animation | undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const follow = turnId === submittedTurn.current ? followAnswerScroll(scroll, motion) : undefined;
    const updateFade = () => viewport.toggleAttribute('data-more-below', scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 2);
    let answerEnd = 0;
    const question = follow && content.querySelector<HTMLElement>(`.next-question[data-turn-id="${turnId}"]`);
    if (question) {
      const heading = content.querySelector<HTMLElement>('.desktop-models, .mobile-model-bar');
      const top = question.getBoundingClientRect().top - content.getBoundingClientRect().top;
      follow.moveTo(top - (heading?.offsetHeight ?? 0) - 12);
    }
    const measure = () => {
      frame = 0;
      const reserved = Array.from(workspace.children).reduce((height, child) => {
        if (child === viewport || !(child instanceof HTMLElement)) return height;
        const style = getComputedStyle(child);
        return height + child.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      }, 0);
      const contentBox = content.getBoundingClientRect();
      const height = Math.max(0, Math.min(Math.ceil(contentBox.height), workspace.clientHeight - reserved));
      if (viewport.style.height !== `${height}px`) viewport.style.height = `${height}px`;
      updateFade();

      if (follow?.enabled) {
        const answers = content.querySelectorAll('[data-current-answer]:not([hidden]) > :is(.markdown, .markdown-fallback)');
        const nextEnd = Math.max(0, ...Array.from(answers, (answer) => answer.getBoundingClientRect().bottom - contentBox.top));
        if (nextEnd > answerEnd) follow.moveTo(Math.min(contentBox.height, nextEnd + 16) - height);
        answerEnd = nextEnd;
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    scheduleMeasure.current = schedule;
    measure();

    const composer = workspace.querySelector<HTMLElement>('.composer');
    const previous = previousComposer.current;
    previousComposer.current = null;
    if (previous && composer && !motion.matches && typeof composer.animate === 'function') {
      const next = composer.getBoundingClientRect();
      animation = composer.animate([
        { transform: `translateY(${previous.top - next.top}px)`, width: `${previous.width}px` },
        { transform: 'translateY(0)', width: `${next.width}px` },
      ], { duration: 480, easing });
    }

    // Observe the rendered content: Markdown can reveal more lines without a new network event.
    // The viewport itself is excluded so its height animation cannot feed back into measurement.
    const observer = new ResizeObserver(schedule);
    observer.observe(workspace);
    observer.observe(content);
    for (const child of workspace.children) if (child !== viewport) observer.observe(child);
    const fadeObserver = new ResizeObserver(updateFade);
    fadeObserver.observe(scroll);
    scroll.addEventListener('scroll', updateFade, { passive: true });
    window.visualViewport?.addEventListener('resize', schedule);
    const reduceMotion = () => { if (motion.matches) animation?.cancel(); };
    motion.addEventListener('change', reduceMotion);
    return () => {
      observer.disconnect();
      fadeObserver.disconnect();
      scroll.removeEventListener('scroll', updateFade);
      cancelAnimationFrame(frame);
      animation?.cancel();
      follow?.dispose();
      window.visualViewport?.removeEventListener('resize', schedule);
      motion.removeEventListener('change', reduceMotion);
      scheduleMeasure.current = null;
    };
  }, [turnId]);

  useLayoutEffect(() => { scheduleMeasure.current?.(); });

  return { workspaceRef, prepareTransition };
}
