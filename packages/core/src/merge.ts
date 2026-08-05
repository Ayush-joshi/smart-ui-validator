import type { DesignContract, DesignElement } from './schemas.js';

export function mergeDesignContracts(primary: DesignContract, secondary?: DesignContract): DesignContract {
  if (!secondary) return primary;

  const mergedAmbiguities = [...primary.ambiguities];
  const mergedElements: DesignElement[] = [];

  const secondaryElementsMap = new Map<string, DesignElement>();
  for (const el of secondary.elements) {
    const key = el.validationId || el.figmaNodeId || el.selector;
    if (key) {
      secondaryElementsMap.set(key, el);
    }
  }

  for (const primaryEl of primary.elements) {
    const key = primaryEl.validationId || primaryEl.figmaNodeId || primaryEl.selector;
    const secondaryEl = key ? secondaryElementsMap.get(key) : undefined;

    if (!secondaryEl) {
      mergedElements.push(primaryEl);
      continue;
    }

    const mergedEl: DesignElement = { ...primaryEl };

    const keysToCheck = Object.keys({ ...primaryEl, ...secondaryEl }) as Array<keyof DesignElement>;
    for (const prop of keysToCheck) {
      const val1 = primaryEl[prop];
      const val2 = secondaryEl[prop];

      if (val1 !== undefined && val2 !== undefined && JSON.stringify(val1) !== JSON.stringify(val2)) {
        mergedAmbiguities.push(
          `Conflict on element ${key || 'unknown'} property '${prop}': primary has '${JSON.stringify(val1)}', secondary has '${JSON.stringify(val2)}'. Primary value was kept.`,
        );
      }

      if (mergedEl[prop] === undefined) {
        (mergedEl as any)[prop] = val2;
      }
    }

    mergedElements.push(mergedEl);
    if (key) {
      secondaryElementsMap.delete(key);
    }
  }

  for (const remainingSecondaryEl of secondaryElementsMap.values()) {
    mergedElements.push(remainingSecondaryEl);
  }

  return {
    ...primary,
    ambiguities: mergedAmbiguities,
    elements: mergedElements,
  };
}
