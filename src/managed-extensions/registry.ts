import { compiledExtensions } from "pi-sandbox:compiled-extensions";

import { createManagedExtensionCatalog } from "./catalog.js";

export const managedExtensionCatalog = createManagedExtensionCatalog(compiledExtensions);
