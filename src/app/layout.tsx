import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import NuraeIntroOverlay from "@/components/nurae/intro-overlay";
import { NURAE_NAME, NURAE_TAGLINE, NURAE_VENDOR, NURAE_VERSION } from "@/lib/nurae/version";

/**
 * Intro boot decision — runs synchronously BEFORE first paint (inline in
 * <head>). Decides per browser session whether the WebGL loading intro plays:
 *   data-nurae-intro='pending' → intro will play; globals.css hides site
 *     content behind the opaque boot layer (no flash of the site underneath).
 *   data-nurae-intro='done'    → intro already played this session
 *     (sessionStorage.nuraeIntroDone) — site renders normally, no loader.
 * A 15s failsafe force-reveals the site if hydration were ever to fail, so
 * the boot layer can never permanently blank the page.
 */
const NURAE_BOOT_SCRIPT = `(function(){var d=document.documentElement;try{if(sessionStorage.getItem('nuraeIntroDone')==='1'){d.setAttribute('data-nurae-intro','done');return}}catch(e){}d.setAttribute('data-nurae-intro','pending');setTimeout(function(){if(d.getAttribute('data-nurae-intro')==='pending')d.setAttribute('data-nurae-intro','done')},15000)})();`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${NURAE_NAME} — ${NURAE_VENDOR}`,
  description: `${NURAE_NAME} ${NURAE_VERSION} — ${NURAE_TAGLINE}. AI-powered Telegram bot creation and operation.`,
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Loader typography — Julius Sans One (wordmark), Share Tech Mono
            (HUD), Jost 300/400 (tagline). Referenced by literal family name
            inside NuraeExperience. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Julius+Sans+One&family=Share+Tech+Mono&family=Jost:wght@300;400&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: NURAE_BOOT_SCRIPT }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}>
        {children}
        <NuraeIntroOverlay />
        <Toaster position="top-center" theme="dark" />
      </body>
    </html>
  );
}
