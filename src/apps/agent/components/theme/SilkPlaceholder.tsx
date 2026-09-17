/**
 * Agent Window — the image-generation placeholder [view].
 *
 * The hole an image occupies while it is being made. A WebGL "silk" shader
 * under two vignette layers, sized to the aspect the image will have, so the
 * picture arrives as a crossfade rather than a layout jump.
 *
 * It exists because generation is SLOW — measured at 36s for a6api's
 * `gpt-image-2`, 41s for an edit. A spinner is honest for 400ms and reads as a
 * hang at half a minute.
 *
 * The shader, its constants, and the vignette gradients are Alvan's, taken
 * verbatim from `public/image-placeholder-loop.html`. The halo and caption in
 * that file sit OUTSIDE its `.box` and are deliberately not reproduced here:
 * the placeholder is the box's contents.
 *
 * Sibling of `StreamingDotMatrix` — same kind of thing (a decorative animated
 * component several surfaces mount), same folder.
 */

import React, { useEffect, useRef } from "react";

import { silkColor } from "@/apps/agent/components/theme/silk-color";

/** Shader constants, verbatim from the reference file's `<Silk … />` props. */
const SPEED = 19.0;
const SCALE = 1.1;
const NOISE = 2.7;
const ROTATION = 2.33;

/**
 * How often the accent is re-read from the cascade, in frames at ~60fps.
 *
 * Polling rather than subscribing to `useAgentThemeStore` keeps this component
 * decoupled from the store, and a theme change is a thing a person does by
 * hand — half a second of lag on a 36-second animation is not perceptible.
 * `getComputedStyle` is not free, which is why it is not every frame.
 */
const ACCENT_POLL_FRAMES = 30;

const VERTEX_SHADER = `attribute vec2 p;
varying vec2 vUv;
void main() {
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** Verbatim from `alvanworld-webapp/components/Silk.tsx` via the reference file. */
const FRAGMENT_SHADER = `precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform vec3 uColor;
uniform float uSpeed;
uniform float uScale;
uniform float uRotation;
uniform float uNoiseIntensity;
const float e = 2.71828182845904523536;
float noise(vec2 texCoord) {
  float G = e;
  vec2 r = (G * sin(G * texCoord));
  return fract(r.x * r.y * (1.0 + texCoord.x));
}
vec2 rotateUvs(vec2 uv, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  mat2 rot = mat2(c, -s, s, c);
  return rot * uv;
}
void main() {
  float rnd = noise(gl_FragCoord.xy);
  vec2 uv = rotateUvs(vUv * uScale, uRotation);
  vec2 tex = uv * uScale;
  float tOffset = uSpeed * uTime;
  tex.y += 0.03 * sin(8.0 * tex.x - tOffset);
  float pattern = 0.6 +
    0.4 * sin(5.0 * (tex.x + tex.y +
      cos(3.0 * tex.x + 5.0 * tex.y) +
      0.02 * tOffset) +
      sin(20.0 * (tex.x + tex.y - 0.1 * tOffset)));
  vec4 col = vec4(uColor, 1.0) * vec4(pattern) - rnd / 15.0 * uNoiseIntensity;
  col.a = 1.0;
  gl_FragColor = col;
}`;

export interface SilkPlaceholderProps {
  /**
   * The aspect the arriving image will have, as CSS `aspect-ratio`
   * (e.g. `"1 / 1"`, `"16 / 9"`). Reserving the true shape is the whole point:
   * the image then crossfades in rather than shoving the transcript down.
   */
  aspectRatio?: string;
  /** Accessible label. Decorative by default — the card around it says what is happening. */
  label?: string;
  className?: string;
}

export const SilkPlaceholder: React.FC<SilkPlaceholderProps> = ({
  aspectRatio = "1 / 1",
  label,
  className,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // The canvas is created HERE, not rendered by React, and thrown away with
    // the effect. React reuses a rendered element across a remount, and the
    // cleanup below deliberately destroys the WebGL context — so on the second
    // mount `getContext` handed back the SAME dead context and every shader
    // failed to compile with `CONTEXT_LOST_WEBGL`. Nothing drew, and the
    // vignette over the empty canvas read as a soft glow that looked
    // intentional. React's StrictMode does exactly that mount → cleanup →
    // mount cycle in development, so the placeholder never once worked in the
    // app while working perfectly in the standalone probe it was ported from.
    // One canvas per mount means the context it owns is only ever its own.
    const canvas = document.createElement("canvas");
    canvas.className = "agw-silk-canvas";
    host.prepend(canvas);

    const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!gl) {
      // No WebGL: a flat field of the same colour still reads as "something is
      // coming", which is the job. Better than an empty black hole.
      const [r, g, b] = silkColor(
        getComputedStyle(host).getPropertyValue("--agw-accent"),
      );
      host.style.background = `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
      canvas.remove();
      return;
    }

    const compile = (type: number, source: string): WebGLShader | null => {
      const stage = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
      const shader = gl.createShader(type);
      if (!shader) {
        console.warn(`[SilkPlaceholder] could not create the ${stage} shader`);
        return null;
      }
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        // Name the STAGE and quote the source. The first version of this logged
        // only `getShaderInfoLog`, which some drivers return as `null` — a
        // failure that says nothing about which of the two shaders failed or
        // why, and cost a round trip on a real machine to narrow down.
        const log = gl.getShaderInfoLog(shader);
        console.warn(
          `[SilkPlaceholder] ${stage} shader did not compile:`,
          log && log.trim() ? log : `(driver gave no reason; gl.getError=${gl.getError()})`,
          "\n--- source ---\n" +
            source
              .split("\n")
              .map((line, index) => `${String(index + 1).padStart(2)} | ${line}`)
              .join("\n"),
        );
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = vertex && fragment ? gl.createProgram() : null;
    if (!vertex || !fragment || !program) {
      canvas.remove();
      return;
    }

    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[SilkPlaceholder] link failed:", gl.getProgramInfoLog(program));
      canvas.remove();
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, "uTime");
    const uColor = gl.getUniformLocation(program, "uColor");
    gl.uniform1f(gl.getUniformLocation(program, "uSpeed"), SPEED);
    gl.uniform1f(gl.getUniformLocation(program, "uScale"), SCALE);
    gl.uniform1f(gl.getUniformLocation(program, "uRotation"), ROTATION);
    gl.uniform1f(gl.getUniformLocation(program, "uNoiseIntensity"), NOISE);

    let lastAccent = "";
    const applyAccent = () => {
      const accent = getComputedStyle(host).getPropertyValue("--agw-accent");
      if (accent === lastAccent) return;
      lastAccent = accent;
      const [r, g, b] = silkColor(accent);
      gl.uniform3f(uColor, r, g, b);
    };
    applyAccent();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = host.getBoundingClientRect();
      const width = Math.max(2, Math.floor(rect.width * dpr));
      const height = Math.max(2, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    let time = 0;
    const draw = () => {
      resize();
      gl.uniform1f(uTime, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // The real media query belongs in the PRODUCT (it is only the design probes
    // that must not carry one, or they look broken rather than reduced).
    // A still frame of the shader is a perfectly good placeholder.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frames = 0;
    let raf = 0;
    let last = performance.now();

    const loop = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.1);
      last = now;
      time += 0.1 * delta; // matches the reference's `uTime += 0.1 * delta`
      if (++frames % ACCENT_POLL_FRAMES === 0) applyAccent();
      draw();
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      if (reduced.matches) {
        draw();
        return;
      }
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    start();

    const onMotionChange = () => start();
    reduced.addEventListener("change", onMotionChange);
    const observer = new ResizeObserver(() => draw());
    observer.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      reduced.removeEventListener("change", onMotionChange);
      observer.disconnect();
      // Free the context explicitly. Browsers cap live WebGL contexts (~16),
      // and a transcript that generated several images would otherwise hold
      // one per card until GC got round to it — at which point the OLDEST
      // context is dropped, blanking a placeholder that is still running.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      // Safe to lose it now: this canvas dies with the effect, so no remount
      // can be handed the context it just destroyed.
      canvas.remove();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className={className ? `agw-silk ${className}` : "agw-silk"}
      style={{ aspectRatio, "--agw-image-ratio": aspectRatio } as React.CSSProperties}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* The canvas is inserted here by the effect — see the note above. */}
      {/* Vignette gradients, verbatim from the reference file. Two layers: a
          radial that darkens the edges and a linear that weights top and
          bottom. They fade in over 3s so the box does not start at full
          contrast the instant it mounts. */}
      <div className="agw-silk-vignette" aria-hidden="true">
        <div className="agw-silk-vignette-radial" />
        <div className="agw-silk-vignette-linear" />
      </div>
    </div>
  );
};

export default SilkPlaceholder;
