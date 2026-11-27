import type { Metadata } from "next";
import AdminApp from "./admin-app";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-8 px-4 py-14">
      <AdminApp />
    </main>
  );
}
