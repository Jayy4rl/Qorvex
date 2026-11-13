import { lazy } from "react";
import { Route, Routes } from "react-router";
import { PublicLayout } from "./components/PublicLayout";
import { ScrollManager } from "./components/ScrollManager";
import Landing from "./pages/landing/Landing";

// The landing page ships in the main bundle; everything else loads on demand.
const DocsPage = lazy(() => import("./pages/docs/DocsPage"));
const SignIn = lazy(() => import("./pages/SignIn"));
const AppHome = lazy(() => import("./pages/AppHome"));
const Check = lazy(() => import("./pages/Check"));
const StatusPage = lazy(() => import("./pages/StatusPage"));
const AcceptInvite = lazy(() => import("./pages/AcceptInvite"));
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
          <Route path="check" element={<Check />} />
          <Route path="c/:network/:contractId" element={<Check />} />
          <Route path="status/:id" element={<StatusPage />} />
          <Route path="accept-invite/:id" element={<AcceptInvite />} />
          <Route path="app/*" element={<AppHome />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}
