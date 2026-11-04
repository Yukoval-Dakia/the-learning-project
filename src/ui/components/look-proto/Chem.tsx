// Formula text for SVG: digits after an element or bracket sit low. The renderer decides this, not the data.
export function ChemTspans({ text }: { text: string }) {
  const parts = text.split(/(?<=[A-Za-z)])(\d+)/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: throwaway prototype
          <tspan key={i} dy="0.28em" fontSize="0.74em">
            {part}
          </tspan>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: throwaway prototype
          <tspan key={i} dy={i > 0 ? '-0.2em' : undefined}>
            {part}
          </tspan>
        ),
      )}
    </>
  );
}
