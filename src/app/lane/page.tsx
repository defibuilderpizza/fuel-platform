import type { Metadata } from "next";
import LaneWorker from "./worker";

export const metadata: Metadata = {
  title: "Laptop lane",
  description: "Run small AI jobs in a browser tab and earn Fuel balance per verified job.",
};

export default function Page() {
  return <LaneWorker />;
}
