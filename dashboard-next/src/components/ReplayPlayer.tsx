import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  Gauge,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { DBEvent } from "@/lib/types";

interface ReplayPlayerProps {
  sessionId: string;
}

const SPEED_OPTIONS = [0.5, 1, 2, 5, 10] as const;
type Speed = (typeof SPEED_OPTIONS)[number];

function eventTypeColor(type: string): string {
  switch (type) {
    case "agent_start":
    case "agent_started":
    case "agent_spawn":
      return "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
    case "agent_done":
    case "agent_completed":
      return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    case "agent_error":
    case "error":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    case "tool_call":
      return "bg-violet-500/20 text-violet-400 border-violet-500/30";
    case "tool_result":
      return "bg-indigo-500/20 text-indigo-400 border-indigo-500/30";
    case "cost_update":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    case "message":
      return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

export function ReplayPlayer({ sessionId }: ReplayPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventsEndRef = useRef<HTMLDivElement | null>(null);

  const {
    data: events,
    isLoading,
    error,
  } = useQuery<DBEvent[]>({
    queryKey: ["replay-events", sessionId],
    queryFn: () => api.sessionEvents(sessionId),
    staleTime: Infinity,
  });

  const totalEvents = events?.length ?? 0;

  const getDelay = useCallback(
    (idx: number): number => {
      if (!events || idx >= events.length - 1) return 0;
      const curr = new Date(events[idx].created_at).getTime();
      const next = new Date(events[idx + 1].created_at).getTime();
      const delta = Math.max(0, next - curr);
      const clamped = Math.min(3000, Math.max(50, delta));
      return clamped / speed;
    },
    [events, speed]
  );

  const elapsed = useCallback((): number => {
    if (!events || events.length === 0 || currentIndex === 0) return 0;
    const start = new Date(events[0].created_at).getTime();
    const current = new Date(
      events[Math.min(currentIndex, events.length - 1)].created_at
    ).getTime();
    return Math.max(0, current - start);
  }, [events, currentIndex]);

  useEffect(() => {
    if (!isPlaying || !events || currentIndex >= events.length - 1) {
      if (isPlaying && currentIndex >= (events?.length ?? 0) - 1) {
        setIsPlaying(false);
      }
      return;
    }

    timerRef.current = setTimeout(() => {
      setCurrentIndex((i) => i + 1);
    }, getDelay(currentIndex));

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPlaying, currentIndex, events, getDelay]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [currentIndex]);

  function togglePlay() {
    if (currentIndex >= totalEvents - 1) {
      setCurrentIndex(0);
      setIsPlaying(true);
    } else {
      setIsPlaying((p) => !p);
    }
  }

  function stepBack() {
    setIsPlaying(false);
    setCurrentIndex((i) => Math.max(0, i - 1));
  }

  function stepForward() {
    setIsPlaying(false);
    setCurrentIndex((i) => Math.min(totalEvents - 1, i + 1));
  }

  function reset() {
    setIsPlaying(false);
    setCurrentIndex(0);
  }

  function handleScrub(e: React.ChangeEvent<HTMLInputElement>) {
    setIsPlaying(false);
    setCurrentIndex(Number(e.target.value));
  }

  function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0)
      return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  if (error) {
    return (
      <Card className="glass">
        <CardContent className="p-6 text-center">
          <p className="text-destructive font-medium">
            Failed to load events for replay
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card className="glass">
        <CardContent className="p-8 text-center text-muted-foreground">
          Loading replay data…
        </CardContent>
      </Card>
    );
  }

  if (!events || events.length === 0) {
    return (
      <Card className="glass">
        <CardContent className="p-8 text-center text-muted-foreground">
          No events to replay
        </CardContent>
      </Card>
    );
  }

  const visibleEvents = events.slice(0, currentIndex + 1);

  return (
    <div className="space-y-4">
      {/* Transport Controls */}
      <Card className="glass">
        <CardContent className="p-4">
          <div className="flex items-center gap-4 flex-wrap">
            {/* Playback buttons */}
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={reset}
                title="Reset"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={stepBack}
                disabled={currentIndex === 0}
                title="Step back"
              >
                <SkipBack className="h-4 w-4" />
              </Button>
              <Button
                variant={isPlaying ? "secondary" : "default"}
                size="icon"
                onClick={togglePlay}
                title={isPlaying ? "Pause" : "Play"}
                className="h-10 w-10"
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5 ml-0.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={stepForward}
                disabled={currentIndex >= totalEvents - 1}
                title="Step forward"
              >
                <SkipForward className="h-4 w-4" />
              </Button>
            </div>

            {/* Timeline scrubber */}
            <div className="flex-1 flex items-center gap-3 min-w-[200px]">
              <span className="text-xs text-muted-foreground tabular-nums min-w-[4rem] text-right">
                {currentIndex + 1} / {totalEvents}
              </span>
              <input
                type="range"
                min={0}
                max={totalEvents - 1}
                value={currentIndex}
                onChange={handleScrub}
                className="flex-1 h-1.5 bg-secondary rounded-lg appearance-none cursor-pointer accent-cyan-400
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:shadow
                  [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:active:cursor-grabbing"
              />
              <span className="text-xs text-muted-foreground tabular-nums min-w-[3.5rem]">
                {formatElapsed(elapsed())}
              </span>
            </div>

            {/* Speed selector */}
            <div className="flex items-center gap-1">
              <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
              {SPEED_OPTIONS.map((s) => (
                <Button
                  key={s}
                  variant={speed === s ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setSpeed(s)}
                  className="text-xs h-7 px-2 min-w-[2.5rem]"
                >
                  {s}x
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Event stream */}
      <Card className="glass">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Event Stream
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({visibleEvents.length} of {totalEvents} events)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-h-[500px] overflow-y-auto space-y-1 pr-2">
            {visibleEvents.map((event, idx) => (
              <div
                key={event.id}
                className={`flex items-start gap-3 p-2 rounded-lg text-sm transition-colors ${
                  idx === currentIndex
                    ? "bg-cyan-500/10 ring-1 ring-cyan-500/30"
                    : "hover:bg-accent/20"
                }`}
              >
                <span className="text-[10px] text-muted-foreground tabular-nums mt-1 min-w-[2rem] text-right">
                  {idx + 1}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums mt-1 min-w-[5rem]">
                  {new Date(event.created_at).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <Badge
                  className={`${eventTypeColor(event.event_type)} text-[10px] shrink-0`}
                >
                  {event.event_type}
                </Badge>
                {event.agent_id && (
                  <span className="text-xs text-muted-foreground font-mono truncate max-w-[100px]">
                    {event.agent_id}
                  </span>
                )}
                <span className="text-xs text-muted-foreground truncate flex-1">
                  {event.payload
                    ? typeof event.payload === "string"
                      ? event.payload
                      : JSON.stringify(event.payload).slice(0, 120)
                    : ""}
                </span>
              </div>
            ))}
            <div ref={eventsEndRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
