import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CHISMOSO — Inteligencia de señales y oportunidades",
  description:
    "Agente especializado en detectar señales tempranas, tendencias, problemas emergentes y oportunidades de negocio antes que otros.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {/* Theme bootstrap — runs before hydration to avoid FOUC.
            Pattern from AGENTE-GENERAL (https://github.com/ALBRA8/AGENTE-GENERAL). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){};`,
          }}
        />
        {/* Kill the Next.js DevTools floating badge ("N" button bottom-right).
            Pattern from AGENTE-GENERAL. Belt-and-suspenders alongside
            `devIndicators: false` in next.config.ts. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  const hide=()=>{
    document.querySelectorAll('nextjs-portal, [data-nextjs-toast], [data-nextjs-dev-overlay], [data-nextjs-dialog-overlay]').forEach(el=>{
      try{el.style.setProperty('display','none','important');el.style.setProperty('visibility','hidden','important');el.style.setProperty('opacity','0','important');el.style.setProperty('pointer-events','none','important');}catch(e){}
      if(el.shadowRoot){
        try{
          const s=document.createElement('style');
          s.textContent='* { display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }';
          el.shadowRoot.appendChild(s);
        }catch(e){}
      }
    });
  };
  if(typeof window!=='undefined'){
    setInterval(hide, 500);
    window.addEventListener('DOMContentLoaded', hide);
  }
})();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen flex flex-col`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
