/**
 * ResizablePanel — drag-to-resize left panel wrapper with collapse toggle.
 *
 * Features:
 * - Drag handle on the right edge for resizing
 * - Chevron button to collapse/expand
 * - Width persisted in localStorage under `storageKey`
 * - Smooth CSS transitions
 * - Min/max width constraints
 */

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ResizablePanelProps {
	/** localStorage key for persisting width */
	storageKey: string;
	/** Minimum width in px (default 200) */
	minWidth?: number;
	/** Maximum width in px (default 500) */
	maxWidth?: number;
	/** Default width when no saved value (default 288) */
	defaultWidth?: number;
	/** Panel content */
	children: React.ReactNode;
	/** Extra class on the panel container */
	className?: string;
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
	return Math.max(minWidth, Math.min(maxWidth, width));
}

function readStoredWidth(key: string, fallback: number, minWidth: number, maxWidth: number): number {
	try {
		const v = localStorage.getItem(key);
		if (v !== null) {
			const n = parseInt(v, 10);
			if (!isNaN(n) && n > 0) return clampWidth(n, minWidth, maxWidth);
		}
	} catch {
		// SSR / localStorage unavailable
	}
	return clampWidth(fallback, minWidth, maxWidth);
}

function readStoredCollapsed(key: string): boolean {
	try {
		return localStorage.getItem(`${key}-collapsed`) === "true";
	} catch {
		return false;
	}
}

export function ResizablePanel({
	storageKey,
	minWidth = 200,
	maxWidth = 500,
	defaultWidth = 288,
	children,
	className,
}: ResizablePanelProps) {
	const [width, setWidth] = React.useState(() =>
		readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth),
	);
	const [collapsed, setCollapsed] = React.useState(() =>
		readStoredCollapsed(storageKey),
	);
	const [dragging, setDragging] = React.useState(false);
	const panelRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		setWidth((current) => clampWidth(current, minWidth, maxWidth));
	}, [minWidth, maxWidth]);

	// Persist width
	React.useEffect(() => {
		try {
			localStorage.setItem(storageKey, String(width));
		} catch {}
	}, [storageKey, width]);

	// Persist collapsed state
	React.useEffect(() => {
		try {
			localStorage.setItem(`${storageKey}-collapsed`, String(collapsed));
		} catch {}
	}, [storageKey, collapsed]);

	const handleMouseDown = React.useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			setDragging(true);
			const startX = e.clientX;
			const startW = width;

			const onMove = (ev: MouseEvent) => {
				setWidth(clampWidth(startW + ev.clientX - startX, minWidth, maxWidth));
			};

			const onUp = () => {
				setDragging(false);
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
			};

			document.body.style.cursor = "col-resize";
			document.body.style.userSelect = "none";
			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
		},
		[width, minWidth, maxWidth],
	);

	const toggleCollapse = React.useCallback(() => {
		setCollapsed((c) => !c);
	}, []);

	const effectiveWidth = collapsed ? 0 : width;

	return (
		<div className="relative flex shrink-0" style={{ height: "100%" }}>
			{/* Panel content */}
			<div
				ref={panelRef}
				className={cn(
					"h-full overflow-hidden border-r border-white/10 bg-slate-950/80",
					!dragging && "transition-[width] duration-200 ease-in-out",
					className,
				)}
				style={{ width: effectiveWidth }}
			>
				{!collapsed && (
					<div className="h-full w-full" style={{ minWidth: minWidth }}>
						{children}
					</div>
				)}
			</div>

			{/* Drag handle */}
			{!collapsed && (
				<div
					className={cn(
						"w-1 shrink-0 cursor-col-resize transition-colors",
						dragging ? "bg-cyan-500/50" : "bg-transparent hover:bg-cyan-500/30",
					)}
					onMouseDown={handleMouseDown}
				/>
			)}

			{/* Collapse / expand toggle */}
			<button
				onClick={toggleCollapse}
				className={cn(
					"absolute top-3 z-10 flex h-6 w-6 items-center justify-center rounded-full",
					"border border-white/10 bg-slate-900 text-zinc-400 hover:text-zinc-100 hover:bg-slate-800",
					"transition-all duration-200 shadow-md",
					collapsed ? "left-1" : "-right-3",
				)}
				title={collapsed ? "Expand panel" : "Collapse panel"}
			>
				{collapsed ? (
					<ChevronRight className="w-3.5 h-3.5" />
				) : (
					<ChevronLeft className="w-3.5 h-3.5" />
				)}
			</button>
		</div>
	);
}
