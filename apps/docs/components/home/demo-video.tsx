"use client"

import { useEffect, useRef, useState } from "react"

const WIDTH = 1354
const HEIGHT = 1140

// A recorded run, not a mock-up. Nothing is downloaded until a quarter of it is on screen, and
// the box keeps its size meanwhile, so the page neither waits for it nor jumps when it arrives.
export function DemoVideo() {
  const box = useRef<HTMLDivElement>(null)
  // undefined until it is on screen; then whether to show a still frame with controls
  const [still, setStill] = useState<boolean>()

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStill(
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
          )
          observer.disconnect()
        }
      },
      { threshold: 0.25 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={box}
      className="overflow-hidden rounded-xl border bg-[#1e1e2e] shadow-lg"
      style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
    >
      {still !== undefined && (
        <video
          className="size-full"
          width={WIDTH}
          height={HEIGHT}
          poster="/demo/commerce-v1-poster.webp"
          autoPlay={!still}
          controls={still}
          loop
          muted
          playsInline
          preload={still ? "none" : "auto"}
          aria-label="radius run on four dependencies of vercel/commerce: two need a review, with the lines concerned, one is quiet, one cannot be seen"
        >
          <source src="/demo/commerce-v1.webm" type="video/webm" />
          <source src="/demo/commerce-v1.mp4" type="video/mp4" />
        </video>
      )}
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/demo/commerce-v1-poster.webp"
          width={WIDTH}
          height={HEIGHT}
          alt="radius run on four dependencies of vercel/commerce"
          className="size-full"
        />
      </noscript>
    </div>
  )
}
