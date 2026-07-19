import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "teach-me",
  description: "Turn a topic into a structured, self-paced course.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="teach-me home">
            teach-me<span aria-hidden="true">.</span>
          </Link>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
