import { Suspense } from "react";
import { Outlet } from "react-router";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

export function PublicLayout() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1}>
        <Suspense fallback={<div className="page-loading" aria-busy="true" />}>
          <Outlet />
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}
