"use client";

import { useId } from "react";
import {
  geoAlbersUsa,
  geoCentroid,
  geoEqualEarth,
  geoPath,
  type GeoProjection,
} from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldAtlas from "world-atlas/countries-110m.json";
import usAtlas from "us-atlas/states-10m.json";
import type { VisualBlockV4 } from "@/lib/course-schema";

const WIDTH = 760;
const HEIGHT = 420;
const COLORS = ["#315f52", "#b06b35", "#654d8d", "#9e3f35"];

type ChartBlock = Extract<VisualBlockV4, { visual: { kind: "chart" } }>;
type DiagramBlock = Extract<VisualBlockV4, { visual: { kind: "diagram" } }>;
type MapBlock = Extract<VisualBlockV4, { visual: { kind: "map" } }>;

function isChart(block: VisualBlockV4): block is ChartBlock {
  return block.visual.kind === "chart";
}

function isDiagram(block: VisualBlockV4): block is DiagramBlock {
  return block.visual.kind === "diagram";
}

function isMap(block: VisualBlockV4): block is MapBlock {
  return block.visual.kind === "map";
}

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const REGION_NAME_ALIASES: Record<string, string> = {
  america: "unitedstatesofamerica",
  burma: "myanmar",
  capeverde: "caboverde",
  congodrc: "demrepcongo",
  czechrepublic: "czechia",
  democraticrepublicofcongo: "demrepcongo",
  drc: "demrepcongo",
  easttimor: "timorleste",
  ivorycoast: "cotedivoire",
  macedonia: "northmacedonia",
  swaziland: "eswatini",
  unitedstates: "unitedstatesofamerica",
  usa: "unitedstatesofamerica",
};

function canonicalRegionName(value: string) {
  const normalized = normalizeName(value);
  return REGION_NAME_ALIASES[normalized] ?? normalized;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(value);
}

function wrapLabel(label: string, characters = 20): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > characters) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${current} ${word}`;
    }
  }
  return lines.slice(0, 3);
}

function Chart({ block }: { block: ChartBlock }) {
  const titleId = useId();
  const descriptionId = useId();
  const { chartType, xLabel, yLabel, series } = block.visual;
  const labels = Array.from(
    new Set(series.flatMap((item) => item.points.map((point) => point.label))),
  );
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const range = maximum - minimum || 1;
  const left = 70;
  const right = 24;
  const top = 28;
  const bottom = 72;
  const plotWidth = WIDTH - left - right;
  const plotHeight = HEIGHT - top - bottom;
  const xPosition = (index: number) =>
    left + ((index + 0.5) / Math.max(labels.length, 1)) * plotWidth;
  const yPosition = (value: number) =>
    top + ((maximum - value) / range) * plotHeight;
  const zeroY = yPosition(0);
  const ticks = Array.from({ length: 5 }, (_, index) =>
    minimum + (range * index) / 4,
  );
  const barGroupWidth = plotWidth / Math.max(labels.length, 1);
  const barWidth = Math.min(
    46,
    (barGroupWidth * 0.72) / Math.max(series.length, 1),
  );

  return (
    <svg
      className="lesson-visual-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>{block.title}</title>
      <desc id={descriptionId}>{block.altText}</desc>
      {ticks.map((tick) => {
        const y = yPosition(tick);
        return (
          <g key={tick}>
            <line className="visual-grid-line" x1={left} x2={WIDTH - right} y1={y} y2={y} />
            <text className="visual-axis-label" x={left - 10} y={y + 4} textAnchor="end">
              {formatNumber(tick)}
            </text>
          </g>
        );
      })}
      <line className="visual-axis" x1={left} x2={WIDTH - right} y1={zeroY} y2={zeroY} />
      {labels.map((label, index) => (
        <text
          className="visual-axis-label"
          x={xPosition(index)}
          y={HEIGHT - bottom + 22}
          textAnchor="middle"
          key={label}
        >
          {label.length > 15 ? `${label.slice(0, 14)}…` : label}
        </text>
      ))}

      {chartType === "bar" &&
        series.flatMap((item, seriesIndex) =>
          labels.flatMap((label, labelIndex) => {
            const point = item.points.find((candidate) => candidate.label === label);
            if (!point) return [];
            const x =
              xPosition(labelIndex) -
              (barWidth * series.length) / 2 +
              seriesIndex * barWidth;
            const y = Math.min(zeroY, yPosition(point.value));
            const height = Math.max(2, Math.abs(zeroY - yPosition(point.value)));
            return [
              <g key={`${item.name}-${label}`}>
                <rect
                  x={x}
                  y={y}
                  width={Math.max(2, barWidth - 2)}
                  height={height}
                  rx="3"
                  fill={COLORS[seriesIndex % COLORS.length]}
                >
                  <title>{`${item.name}, ${label}: ${formatNumber(point.value)}`}</title>
                </rect>
              </g>,
            ];
          }),
        )}

      {(chartType === "line" || chartType === "scatter") &&
        series.map((item, seriesIndex) => {
          const coordinates = labels.flatMap((label, labelIndex) => {
            const point = item.points.find((candidate) => candidate.label === label);
            return point
              ? [{
                  label,
                  value: point.value,
                  x: xPosition(labelIndex),
                  y: yPosition(point.value),
                }]
              : [];
          });
          return (
            <g key={item.name}>
              {chartType === "line" && coordinates.length > 1 && (
                <polyline
                  points={coordinates.map(({ x, y }) => `${x},${y}`).join(" ")}
                  fill="none"
                  stroke={COLORS[seriesIndex % COLORS.length]}
                  strokeWidth="3"
                  strokeLinejoin="round"
                />
              )}
              {coordinates.map(({ label, value, x, y }) => (
                <circle
                  cx={x}
                  cy={y}
                  r={chartType === "scatter" ? 6 : 5}
                  fill={COLORS[seriesIndex % COLORS.length]}
                  key={label}
                >
                  <title>{`${item.name}, ${label}: ${formatNumber(value)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}

      <text className="visual-axis-title" x={left + plotWidth / 2} y={HEIGHT - 12} textAnchor="middle">
        {xLabel}
      </text>
      <text
        className="visual-axis-title"
        x="16"
        y={top + plotHeight / 2}
        textAnchor="middle"
        transform={`rotate(-90 16 ${top + plotHeight / 2})`}
      >
        {yLabel}
      </text>
      <g transform={`translate(${left}, 8)`}>
        {series.map((item, index) => (
          <g transform={`translate(${index * 155}, 0)`} key={item.name}>
            <circle cx="5" cy="5" r="5" fill={COLORS[index % COLORS.length]} />
            <text className="visual-legend-label" x="15" y="9">{item.name}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function Diagram({ block }: { block: DiagramBlock }) {
  const titleId = useId();
  const descriptionId = useId();
  const markerId = useId().replace(/:/g, "");
  const { nodes, edges } = block.visual;
  const nodePosition = (node: (typeof nodes)[number]) => ({
    x: 50 + (node.x / 100) * (WIDTH - 100),
    y: 42 + (node.y / 100) * (HEIGHT - 84),
  });

  return (
    <svg
      className="lesson-visual-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>{block.title}</title>
      <desc id={descriptionId}>{block.altText}</desc>
      <defs>
        <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" className="visual-arrow" />
        </marker>
      </defs>
      {edges.map((edge, index) => {
        const from = nodes.find((node) => node.id === edge.from);
        const to = nodes.find((node) => node.id === edge.to);
        if (!from || !to) return null;
        const start = nodePosition(from);
        const end = nodePosition(to);
        const deltaX = end.x - start.x;
        const deltaY = end.y - start.y;
        const distance = Math.hypot(deltaX, deltaY) || 1;
        const startInset = Math.min(42, distance / 4);
        const endInset = Math.min(78, distance / 3);
        const lineStart = {
          x: start.x + (deltaX / distance) * startInset,
          y: start.y + (deltaY / distance) * startInset,
        };
        const lineEnd = {
          x: end.x - (deltaX / distance) * endInset,
          y: end.y - (deltaY / distance) * endInset,
        };
        return (
          <g key={`${edge.from}-${edge.to}-${index}`}>
            <line
              className="visual-diagram-edge"
              x1={lineStart.x}
              y1={lineStart.y}
              x2={lineEnd.x}
              y2={lineEnd.y}
              markerEnd={`url(#${markerId})`}
            />
            {edge.label && (
              <text
                className="visual-edge-label"
                x={(start.x + end.x) / 2}
                y={(start.y + end.y) / 2 - 7}
                textAnchor="middle"
              >
                {edge.label}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((node) => {
        const position = nodePosition(node);
        const lines = wrapLabel(node.label);
        return (
          <g transform={`translate(${position.x}, ${position.y})`} key={node.id}>
            <rect className="visual-diagram-node" x="-72" y="-31" width="144" height="62" rx="12" />
            <text className="visual-node-label" textAnchor="middle">
              {lines.map((line, index) => (
                <tspan x="0" dy={index === 0 ? `${-(lines.length - 1) * 0.6}em` : "1.2em"} key={line}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

type Atlas = Topology<{
  countries?: GeometryCollection;
  states?: GeometryCollection;
}>;

function MapVisual({ block }: { block: MapBlock }) {
  const titleId = useId();
  const descriptionId = useId();
  const isWorld = block.visual.scope === "world";
  const topology = (isWorld ? worldAtlas : usAtlas) as unknown as Atlas;
  const object = isWorld ? topology.objects.countries : topology.objects.states;
  if (!object) return null;
  const regions = feature(topology, object) as FeatureCollection<Geometry, { name?: string }>;
  const projection: GeoProjection = isWorld ? geoEqualEarth() : geoAlbersUsa();
  projection.fitExtent(
    [[18, 18], [WIDTH - 18, HEIGHT - 58]],
    regions,
  );
  const path = geoPath(projection);
  const groupKey = (region: (typeof block.visual.highlightedRegions)[number]) =>
    region.label
      ? `label:${normalizeName(region.label)}`
      : `region:${canonicalRegionName(region.name)}`;
  const groupKeys = Array.from(
    new Set(block.visual.highlightedRegions.map(groupKey)),
  );
  const labelCounts = new Map<string, number>();
  block.visual.highlightedRegions.forEach((region) => {
    if (!region.label) return;
    const key = normalizeName(region.label);
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  });
  const highlights = new Map(
    block.visual.highlightedRegions.map((region) => [
      canonicalRegionName(region.name),
      {
        ...region,
        color: COLORS[groupKeys.indexOf(groupKey(region)) % COLORS.length],
      },
    ]),
  );
  const legendEntries = groupKeys.map((key, index) => {
    const region = block.visual.highlightedRegions.find(
      (candidate) => groupKey(candidate) === key,
    );
    return {
      key,
      label: region?.label ?? region?.name ?? "Highlighted region",
      color: COLORS[index % COLORS.length],
    };
  });
  const displayedLegend = legendEntries.slice(0, 4);

  return (
    <svg
      className="lesson-visual-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>{block.title}</title>
      <desc id={descriptionId}>{block.altText}</desc>
      {regions.features.map((region: Feature<Geometry, { name?: string }>, index) => {
        const name = region.properties?.name ?? String(index);
        const highlight = highlights.get(canonicalRegionName(name));
        const regionPath = path(region);
        if (!regionPath) return null;
        return (
          <path
            d={regionPath}
            className={highlight ? "visual-map-region visual-map-region-highlighted" : "visual-map-region"}
            fill={highlight?.color}
            key={name}
          >
            <title>
              {highlight?.label ? `${name}: ${highlight.label}` : name}
            </title>
          </path>
        );
      })}
      {block.visual.markers.map((marker) => {
        const position = projection([marker.longitude, marker.latitude]);
        if (!position) return null;
        return (
          <g transform={`translate(${position[0]}, ${position[1]})`} key={`${marker.label}-${marker.latitude}-${marker.longitude}`}>
            <circle className="visual-map-marker-halo" r="8" />
            <circle className="visual-map-marker" r="4" />
            <text className="visual-map-label" x="8" y="-7">{marker.label}</text>
          </g>
        );
      })}
      {block.visual.highlightedRegions.flatMap((highlight) => {
        if (
          !highlight.label ||
          (labelCounts.get(normalizeName(highlight.label)) ?? 0) > 1
        ) {
          return [];
        }
        const region = regions.features.find(
          (candidate) =>
            canonicalRegionName(candidate.properties?.name ?? "") ===
            canonicalRegionName(highlight.name),
        );
        if (!region || !highlight.label) return [];
        const center = projection(geoCentroid(region));
        if (!center) return [];
        return [
          <text
            className="visual-map-label"
            x={center[0]}
            y={center[1]}
            textAnchor="middle"
            key={`label-${highlight.name}`}
          >
            {highlight.label}
          </text>,
        ];
      })}
      <g transform={`translate(18, ${HEIGHT - 28})`}>
        {displayedLegend.map((entry, index) => (
          <g transform={`translate(${index * 150}, 0)`} key={entry.key}>
            <rect width="12" height="12" rx="2" fill={entry.color} />
            <text className="visual-legend-label" x="18" y="11">
              {entry.label}
            </text>
          </g>
        ))}
        {legendEntries.length > displayedLegend.length && (
          <text className="visual-legend-label" x="618" y="11">
            +{legendEntries.length - displayedLegend.length} more
          </text>
        )}
      </g>
    </svg>
  );
}

export function LessonVisual({ block, compact = false }: { block: VisualBlockV4; compact?: boolean }) {
  return (
    <figure className={`lesson-visual ${compact ? "lesson-visual-compact" : ""}`}>
      <div className="lesson-visual-heading">
        <h3>{block.title}</h3>
        <span>{block.visual.kind}</span>
      </div>
      {isChart(block) && <Chart block={block} />}
      {isDiagram(block) && <Diagram block={block} />}
      {isMap(block) && <MapVisual block={block} />}
      <figcaption>{block.caption}</figcaption>
    </figure>
  );
}
