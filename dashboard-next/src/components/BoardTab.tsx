import * as React from "react";
import { AlertTriangle, CheckCircle2, Clock, KanbanSquare, PlayCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildBoardCards } from "@/lib/board";
import type { BoardColumn } from "@/lib/board";
import { mergeSessionEvents } from "@/lib/session-events";
import type { DBEvent, DBSession, LiveEvent } from "@/lib/types";
import { shortId } from "@/lib/utils";

const columns: Array<{ id: BoardColumn; title: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "planned", title: "Planned", icon: Clock },
  { id: "in-progress", title: "In Progress", icon: PlayCircle },
  { id: "review", title: "Review", icon: KanbanSquare },
  { id: "blocked", title: "Blocked", icon: AlertTriangle },
  { id: "done", title: "Done", icon: CheckCircle2 },
];

export function BoardTab({ session, historyEvents, liveEvents }: { session: DBSession; historyEvents: DBEvent[]; liveEvents: LiveEvent[] }) {
  const cards = React.useMemo(() => buildBoardCards(mergeSessionEvents(historyEvents, liveEvents)), [historyEvents, liveEvents]);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Session board</h3>
          <p className="text-xs text-slate-500">Task cards derived from live and replayed events for {shortId(session.id)}.</p>
        </div>
        <Badge variant="outline">{cards.length} cards</Badge>
      </div>
      <div className="grid gap-3 xl:grid-cols-5 md:grid-cols-2">
        {columns.map((column) => {
          const Icon = column.icon;
          const columnCards = cards.filter((card) => card.column === column.id);
          return (
            <Card key={column.id} className="border-white/10 bg-slate-950/50">
              <CardHeader className="px-3 py-2 border-b border-white/5">
                <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-300">
                  <Icon className="h-3.5 w-3.5" /> {column.title}
                  <span className="ml-auto text-slate-500">{columnCards.length}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 p-3 min-h-32">
                {columnCards.length === 0 ? <div className="text-xs text-slate-600">No cards</div> : null}
                {columnCards.map((card) => (
                  <div key={card.id} className="rounded-lg border border-white/10 bg-slate-900/70 p-2 shadow-sm">
                    <div className="text-sm font-medium text-zinc-100 line-clamp-3">{card.title}</div>
                    <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-slate-400">
                      {card.agentId ? <Badge variant="secondary">{shortId(card.agentId)}</Badge> : null}
                      {card.model ? <Badge variant="outline">{card.model}</Badge> : null}
                    </div>
                    {card.detail ? <div className="mt-1 text-xs text-slate-500 line-clamp-2">{card.detail}</div> : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
