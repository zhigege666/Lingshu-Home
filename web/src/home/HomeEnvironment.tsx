import { createContext, useContext } from 'react';
import type { EndpointRouter } from '../core/endpoint-routing';

// A preview uses the iframe's viewport and its own in-memory interactions.
// Keeping this separate from page configuration avoids persisting preview state.
export type HomeEndpointRouting = { router: EndpointRouter; enabled: boolean; contextKey: string };
export const HomeEnvironment = createContext<{ preview: boolean; viewportWindow?: Window; endpointRouting?: HomeEndpointRouting }>({ preview: false });
export const useHomeEnvironment = () => useContext(HomeEnvironment);
