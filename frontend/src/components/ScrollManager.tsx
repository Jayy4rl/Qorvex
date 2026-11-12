import { useEffect } from "react";
import { useLocation } from "react-router";

/** Scrolls to the hash target on navigation, or to the top for a new page. */
export function ScrollManager() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    if (hash) {
      const id = decodeURIComponent(hash.slice(1));
      // Wait a frame so lazily rendered pages have mounted their sections.
      let tries = 0;
      const tryScroll = () => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          if (el.tabIndex < 0 && !/^(A|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) el.setAttribute("tabindex", "-1");
          el.focus({ preventScroll: true });
        } else if (tries++ < 20) {
          requestAnimationFrame(tryScroll);
        }
      };
      requestAnimationFrame(tryScroll);
    } else {
      window.scrollTo({ top: 0 });
    }
  }, [pathname, hash, key]);
  return null;
}
