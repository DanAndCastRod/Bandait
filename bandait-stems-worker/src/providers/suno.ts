// Suno todavia no tiene API oficial abierta: hay un programa de socios (plan del Estudio, seccion
// 12, punto 5). Mientras Bandait no tenga acceso, `generate` con `provider: "suno"` responde 501
// `provider_unavailable`, exista o no SUNO_API_KEY. No se usan envoltorios no oficiales: violan
// sus terminos. Cuando haya acceso, este archivo implementa `generate` igual que lyria.ts.

import { ProviderError } from './types.ts';
import type { GenerateProvider } from './types.ts';

export const suno: GenerateProvider = {
  assertAvailable(): void {
    throw new ProviderError(501, 'provider_unavailable', 'suno: sin API oficial');
  },
  async generate(): Promise<never> {
    throw new ProviderError(501, 'provider_unavailable', 'suno: sin API oficial');
  },
};
