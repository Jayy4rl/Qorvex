import { useEffect, useRef } from "react";

/** Sets the document title for the current page. */
export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Qorvex` : "Qorvex · Runtime security for NEAR";
  }, [title]);
}

/** Adds `is-visible` to elements with `.reveal` inside the returned ref once they scroll into view. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(".reveal"));
    if (!("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("is-visible"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return ref;
}
