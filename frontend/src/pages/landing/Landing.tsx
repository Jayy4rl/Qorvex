import { useReveal, useTitle } from "../../lib/hooks";
import { Hero } from "./Hero";
import { Approach, Capabilities, FinalCta, HowItWorks, Problem, TrustModel, Verification } from "./Sections";
import "../../styles/landing.css";

export default function Landing() {
  useTitle("");
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className="landing">
      <Hero />
      <Problem />
      <Approach />
      <HowItWorks />
      <Capabilities />
      <TrustModel />
      <Verification />
      <FinalCta />
    </div>
  );
}
