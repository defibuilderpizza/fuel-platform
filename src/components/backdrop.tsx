// Something for the glass to frost: soft shapes in the five greys and a faint grid, fixed
// behind every page. Without texture behind them, frosted panels look like plain grey cards.

export default function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 -top-[30vh] -bottom-[30vh] -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,0,0,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.045) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 80% 70% at 50% 30%, #000 40%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 70% at 50% 30%, #000 40%, transparent 100%)",
        }}
      />
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="orb orb-c" />
      <div className="orb orb-d" />
    </div>
  );
}
