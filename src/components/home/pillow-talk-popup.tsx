"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { pillowTalkPath } from "@/lib/site";

const sessionKey = "kozy:pillow-talk-popup-seen";

export default function PillowTalkPopup() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (sessionStorage.getItem(sessionKey)) return;
      } catch {
        // Restricted storage still allows the popup to open.
      }

      const dialog = dialogRef.current;
      if (!dialog?.isConnected || dialog.open) return;
      dialog.showModal();

      try {
        sessionStorage.setItem(sessionKey, "1");
      } catch {
        // Dismissal works even when the session cannot be remembered.
      }
    }, 3500);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Pillow Talk Holiday Kapsule Kollection"
      className="overflow-hidden rounded-plate border-0 bg-card p-0 shadow-lift backdrop:bg-black/55"
      style={{
        position: "fixed",
        inset: 0,
        margin: "auto",
        width: "min(520px, calc(100vw - 32px), 78dvh)",
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "calc(100dvh - 32px)",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <div className="relative aspect-square w-full">
        <Link
          href={pillowTalkPath}
          className="absolute inset-0 block focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4"
          onClick={() => dialogRef.current?.close()}
        >
          <Image
            src="/media/pillow-talk-popup.webp"
            alt="Pillow Talk Holiday Kapsule Kollection. Shop the Sleepover Set."
            fill
            sizes="(max-width: 552px) calc(100vw - 32px), 520px"
            className="object-contain"
          />
        </Link>
        <button
          type="button"
          aria-label="Close Pillow Talk popup"
          autoFocus
          className="absolute right-2 top-2 grid h-10 w-10 place-items-center rounded-full bg-white text-2xl leading-none text-ink"
          onClick={() => dialogRef.current?.close()}
        >
          <span aria-hidden>×</span>
        </button>
      </div>
    </dialog>
  );
}
