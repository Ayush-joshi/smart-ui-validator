import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RepairProvider, RepairProposalInput } from './repair-provider.js';
import type { ProposedChange } from './providers.js';

export class HeuristicRepairProvider implements RepairProvider {
  readonly name = 'heuristic-repair-provider';

  async proposeRepair(input: RepairProposalInput): Promise<ProposedChange[]> {
    const changes: ProposedChange[] = [];

    for (const finding of input.findings) {
      if (finding.category === 'appearance' && finding.suggestedRepairCategory === 'background_color') {
        const cssPath = 'src/styles.css';
        const absoluteCssPath = resolve(input.inspection.root, cssPath);
        try {
          let cssContent = await readFile(absoluteCssPath, 'utf8');
          const expected = finding.expected as string;
          const actual = finding.actual as string;
          if (cssContent.includes(actual)) {
            cssContent = cssContent.replace(actual, expected);
            changes.push({
              relativePath: cssPath,
              content: cssContent,
              rationale: `Fix background color mismatch from ${actual} to ${expected}`,
            });
          }
        } catch {
          // Skip if file doesn't exist
        }
      }
    }

    return changes;
  }
}
