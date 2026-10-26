import {
  useCallback,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";

import {
  normalizePinCoordinates,
  type FeedbackStatus,
} from "../../shared/feedback";
import {
  isPinDrag,
  normalizePinBox,
  pinFromBox,
  type BoxPin,
  type PinBox,
} from "../../shared/pin-box";

function onButton(target: EventTarget) {
  return target instanceof Element && Boolean(target.closest("button"));
}

type DragStart = { x: number; y: number; pointerId: number };

// Place-pin gestures on the screen frame: a click drops a point pin, a drag
// of more than PIN_DRAG_THRESHOLD px draws a box. Pins are stored relative to
// the frame, which keeps the screen's aspect ratio, so they land on the same
// spot at any size. Touch keeps tap-to-pin so a drag still scrolls.
export function usePinDrag({
  enabled,
  onPlace,
}: {
  enabled: boolean;
  onPlace: (pin: BoxPin) => void;
}) {
  const start = useRef<DragStart | null>(null);
  const dragging = useRef(false);
  // The click that follows a drag's pointerup must not also drop a point.
  const swallowClick = useRef(false);
  const [preview, setPreview] = useState<PinBox | null>(null);

  const reset = useCallback(() => {
    start.current = null;
    dragging.current = false;
    setPreview(null);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (
        !enabled ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        onButton(event.target)
      ) {
        return;
      }
      start.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
      dragging.current = false;
    },
    [enabled],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const from = start.current;
    if (!from || event.pointerId !== from.pointerId) return;
    const to = { x: event.clientX, y: event.clientY };
    if (!dragging.current) {
      if (!isPinDrag(from, to)) return;
      dragging.current = true;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Capture is a nicety: the box still clamps to the frame without it.
      }
    }
    setPreview(
      normalizePinBox(from, to, event.currentTarget.getBoundingClientRect()),
    );
  }, []);

  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const from = start.current;
      const drew = dragging.current;
      reset();
      if (!from || !drew || event.pointerId !== from.pointerId) return;
      swallowClick.current = true;
      const box = normalizePinBox(
        from,
        { x: event.clientX, y: event.clientY },
        event.currentTarget.getBoundingClientRect(),
      );
      if (box.w > 0 && box.h > 0) onPlace(pinFromBox(box));
    },
    [onPlace, reset],
  );

  const onClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      if (!enabled || onButton(event.target)) return;
      onPlace(
        normalizePinCoordinates(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
        ),
      );
    },
    [enabled, onPlace],
  );

  return {
    preview,
    handlers: {
      onClick,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: reset,
    },
  };
}

// Status and selection classes for a box, matching its badge's states.
export function pinBoxClassName(status: FeedbackStatus, selected: boolean) {
  return [
    status === "RESOLVED" ? "is-fixed" : "",
    status === "VERIFIED" ? "is-verified" : "",
    status === "WONT_FIX" ? "is-closed" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function boxStyle(box: PinBox) {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.w * 100}%`,
    height: `${box.h * 100}%`,
  };
}

// A box pin's region on the canvas. Decorative: the numbered badge drawn at
// its top-left is the control and the focus target.
export function PinBoxOutline({
  box,
  className = "",
  testId,
}: {
  box: PinBox;
  className?: string;
  testId: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`feedback-box ${className}`.trim()}
      data-testid={testId}
      style={boxStyle(box)}
    />
  );
}
