import { lazy } from "react";
import { Route, Routes } from "react-router";
import { PublicLayout } from "./components/PublicLayout";
import { ScrollManager } from "./components/ScrollManager";
import Landing from "./pages/landing/Landing";

// The landing page ships in the main bundle; everything else loads on demand.
const DocsPage = lazy(() => import("./pages/docs/DocsPage"));
const SignIn = lazy(() => import("./pages/SignIn"));
const AppHome = lazy(() => import("./pages/AppHome"));
const NotFound = lazy(() => import("./pages/NotFound"));

export function AppRoutes() {
  return (
    <>
      <ScrollManager />
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Landing />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="docs/:slug" element={<DocsPage />} />
          <Route path="sign-in" element={<SignIn />} />
          <Route path="app/*" element={<AppHome />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
