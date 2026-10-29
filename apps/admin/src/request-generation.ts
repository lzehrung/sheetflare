import { useState } from 'react';

/** Latest-request-wins guard: only the response of the most recently begun request may be committed. */
export type RequestGeneration = {
  begin(): number;
  isCurrent(id: number): boolean;
};

function createRequestGeneration(): RequestGeneration {
  let latest = 0;

  return {
    begin() {
      latest += 1;
      return latest;
    },
    isCurrent(id) {
      return id === latest;
    }
  };
}

export function useRequestGeneration(): RequestGeneration {
  const [generation] = useState(createRequestGeneration);
  return generation;
}
