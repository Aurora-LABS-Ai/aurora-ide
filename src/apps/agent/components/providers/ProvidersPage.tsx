/**
 * Agent Window — Providers [view].
 *
 * Where the models come from, in the Plugins page's shape so the two read as
 * one system. The **overview**: every provider as a tile, grouped the way the
 * user filed them (their categories, then Aurora's own Built-in and Custom),
 * each with its mark, its name and one line of state — how many models, or
 * "No key", or "Disabled" — and a "Needs attention" count for the ones that
 * are switched on but cannot be called. Image providers have their own group.
 * A **provider's own page** opens from a tile: a breadcrumb back to
 * Providers, then the full detail (`ProviderDetail` / `ImageProviderCard`,
 * unchanged from settings): key or sign-in, address, test, usage, models.
 *
 * It replaced a master–detail screen whose provider list sat beside the
 * settings nav as a second sidebar. Nothing was lost but the pins, which
 * existed to lift one row out of a list of forty; a grid has no such row.
 */

import React, { useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgwButton } from "@/apps/agent/settings/primitives";
import { ProviderAvatar } from "@/apps/agent/settings/ProviderAvatar";
import { ProviderDetail } from "@/apps/agent/settings/ProvidersSettings";
import { ImageProviderCard } from "@/apps/agent/settings/ImageProvidersSection";
import { providerLine, providerReady } from "@/apps/agent/settings/provider-ready";
import { RailMenu, type RailMenuState } from "@/apps/agent/components/shell/RailMenu";
import { sectionsFor } from "@/apps/agent/services/providers/provider-categories";
import {
  imageProviderReady,
  type ImageProvider,
} from "@/apps/agent/services/providers/image-providers";
import { groupProviders } from "@/apps/agent/services/providers/built-in";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useModelMetadataBackfill } from "@/apps/agent/hooks/providers/useModelMetadataBackfill";
import type { LLMModel, LLMProvider } from "@/apps/agent/store/settings/provider-model";

type Selection = { kind: "llm"; id: string } | { kind: "image"; id: string } | null;

const ProviderTile: React.FC<{
  name: string;
  line: string;
  ready: boolean;
  enabled: boolean;
  avatar: React.ReactNode;
  onOpen: () => void;
}> = ({ name, line, ready, enabled, avatar, onOpen }) => (
  <button type="button" className="agw-plug-tile" onClick={onOpen} title={`Open ${name}`}>
    <span className="agw-plug-mark agw-plug-mark-avatar">
      {avatar}
      <span
        className="agw-mcp-card-dot"
        data-tone={ready ? "ready" : enabled ? "warn" : "off"}
      />
    </span>
    <span className="agw-plug-tile-text">
      <span className="agw-plug-tile-name">{name}</span>
      <span
        className="agw-plug-tile-line"
        data-issue={!ready && enabled ? "unnamed" : undefined}
      >
        {line}
      </span>
    </span>
  </button>
);

const Crumbs: React.FC<{ name: string; onBack: () => void }> = ({ name, onBack }) => (
  <nav className="agw-plug-crumbs" aria-label="Breadcrumb">
    <button type="button" className="agw-plug-crumb" onClick={onBack}>
      Providers
    </button>
    <AgentIcon name="chevron-right" size={12} />
    <span className="agw-plug-crumb-here" aria-current="page">
      {name}
    </span>
  </nav>
);

export const ProvidersPage: React.FC = () => {
  const providers = useAgentSettingsStore((s) => s.providers);
  const models = useAgentSettingsStore((s) => s.models);
  const selectedModel = useAgentSettingsStore((s) => s.selectedModel);
  const imageProviders = useAgentSettingsStore((s) => s.imageProviders);
  const providerCategories = useAgentSettingsStore((s) => s.providerCategories);
  const addCustomProvider = useAgentSettingsStore((s) => s.addCustomProvider);
  const addImageProvider = useAgentSettingsStore((s) => s.addImageProvider);

  // A barren seeded model gets its context window, prices and capabilities
  // filled from models.dev while this page is open — the page's one job
  // beyond showing things, carried over from the list it replaced.
  useModelMetadataBackfill();

  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [menu, setMenu] = useState<RailMenuState | null>(null);
  const addButton = useRef<HTMLDivElement>(null);

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, LLMModel[]>();
    for (const model of models) {
      const list = map.get(model.providerId) ?? [];
      list.push(model);
      map.set(model.providerId, list);
    }
    return map;
  }, [models]);

  // Shipped rows first, then the user's own, inside each category — the order
  // the old list drew, so nothing moves for someone who knew where things were.
  const ordered = useMemo(() => {
    const { builtIn, custom } = groupProviders(providers);
    return [...builtIn, ...custom];
  }, [providers]);
  const sections = useMemo(
    () => sectionsFor(providerCategories, ordered),
    [providerCategories, ordered],
  );

  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);
  const needsAttention = (provider: LLMProvider) => provider.enabled && !providerReady(provider);
  const attentionCount =
    providers.filter(needsAttention).length +
    imageProviders.filter((p) => p.enabled && !imageProviderReady(p)).length;
  const readyCount = providers.filter(providerReady).length;

  const open = (next: Selection) => {
    setSelection(next);
    document.querySelector(".agw-plug-scroll")?.scrollTo({ top: 0 });
  };
  const back = () => setSelection(null);

  const addMenu = () => {
    const anchor = addButton.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setMenu({
      anchor,
      x: rect.right,
      y: rect.bottom + 6,
      items: [
        {
          icon: "providers",
          label: "Custom provider",
          onSelect: () => {
            const id = addCustomProvider({
              name: "New provider",
              baseUrl: "",
              apiKey: "",
              model: "",
              contextWindow: 128000,
              maxOutputTokens: 8192,
              supportsThinking: false,
              supportsToolStream: true,
              providerType: "openai",
              requiresApiKey: true,
              enabled: true,
            });
            open({ kind: "llm", id });
          },
        },
        {
          icon: "image",
          label: "Image provider",
          onSelect: () => {
            const id = addImageProvider({
              name: "New image provider",
              baseUrl: "",
              apiFormat: "openai-images",
              enabled: true,
            });
            open({ kind: "image", id });
          },
        },
      ],
    });
  };

  const selectedLlm =
    selection?.kind === "llm" ? (providers.find((p) => p.id === selection.id) ?? null) : null;
  const selectedImage =
    selection?.kind === "image"
      ? (imageProviders.find((p) => p.id === selection.id) ?? null)
      : null;

  const shell = (children: React.ReactNode) => (
    <div className="agw-settings agw-providers">
      <div className="agw-settings-main">
        <div className="agw-settings-content" data-full-bleed>
          <div className="agw-plug">{children}</div>
        </div>
      </div>
    </div>
  );

  if (selectedLlm) {
    return shell(
      <div className="agw-plug-scroll agw-scroll">
        <div className="agw-plug-col">
          <Crumbs name={selectedLlm.nickname || selectedLlm.name} onBack={back} />
          <ProviderDetail
            key={selectedLlm.id}
            provider={selectedLlm}
            models={modelsByProvider.get(selectedLlm.id) ?? []}
            selectedModel={selectedModel}
            onDeleted={back}
            onSelectProvider={(id) => open({ kind: "llm", id })}
          />
        </div>
      </div>,
    );
  }

  if (selectedImage) {
    return shell(
      <div className="agw-plug-scroll agw-scroll">
        <div className="agw-plug-col">
          <Crumbs name={selectedImage.name} onBack={back} />
          <div className="agw-prov-detail">
            <ImageProviderCard
              key={selectedImage.id}
              provider={selectedImage}
              initiallyOpen
              standalone
            />
          </div>
        </div>
      </div>,
    );
  }

  const imageShown = imageProviders.filter(
    (p) => matches(p.name) && (!attentionOnly || (p.enabled && !imageProviderReady(p))),
  );

  return shell(
    <>
      <header className="agw-plug-head">
        <div className="agw-plug-col agw-plug-head-row">
          <div className="agw-plug-titles">
            <h2 className="agw-plug-title">Providers</h2>
            <p className="agw-plug-sub">Where the models come from, and the keys that unlock them</p>
          </div>
          <label className="agw-plug-search">
            <AgentIcon name="search" size={13} />
            <input
              type="search"
              aria-label="Search providers"
              placeholder="Search providers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div ref={addButton}>
            <AgwButton variant="primary" icon="plus" onClick={addMenu}>
              Add
            </AgwButton>
          </div>
        </div>
      </header>

      <div className="agw-plug-scroll agw-scroll">
        <div className="agw-plug-col">
          <div className="agw-plug-sec">
            <h3>Providers</h3>
            <span className="agw-plug-n">
              {providers.length} {providers.length === 1 ? "provider" : "providers"} · {readyCount}{" "}
              ready
            </span>
            {attentionCount > 0 && (
              <button
                type="button"
                className="agw-plug-attn"
                aria-pressed={attentionOnly}
                onClick={() => setAttentionOnly((v) => !v)}
                title={
                  attentionOnly
                    ? "Show every provider"
                    : "Show only providers that are on but cannot be called"
                }
              >
                Needs attention {attentionCount}
              </button>
            )}
          </div>

          {sections.map((section) => {
            const shown = section.providers.filter(
              (provider) =>
                matches(provider.nickname || provider.name) &&
                (!attentionOnly || needsAttention(provider)),
            );
            if (shown.length === 0) return null;
            return (
              <div key={section.category.id} className="agw-plug-cat">
                <div className="agw-plug-cat-label">{section.category.name}</div>
                <div className="agw-plug-tiles">
                  {shown.map((provider) => (
                    <ProviderTile
                      key={provider.id}
                      name={provider.nickname || provider.name}
                      line={providerLine(provider, modelsByProvider.get(provider.id)?.length ?? 0)}
                      ready={providerReady(provider)}
                      enabled={provider.enabled}
                      avatar={<ProviderAvatar provider={provider} small />}
                      onOpen={() => open({ kind: "llm", id: provider.id })}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {imageShown.length > 0 && (
            <div className="agw-plug-cat">
              <div className="agw-plug-cat-label">Image providers</div>
              <div className="agw-plug-tiles">
                {imageShown.map((provider: ImageProvider) => (
                  <ProviderTile
                    key={provider.id}
                    name={provider.name}
                    line={
                      !provider.enabled
                        ? "Disabled"
                        : !imageProviderReady(provider)
                          ? "Needs an address and a key"
                          : `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`
                    }
                    ready={imageProviderReady(provider)}
                    enabled={provider.enabled}
                    avatar={
                      <span className="agw-prov-avatar agw-prov-avatar-sm">
                        <AgentIcon name="image" size={13} />
                      </span>
                    }
                    onOpen={() => open({ kind: "image", id: provider.id })}
                  />
                ))}
              </div>
            </div>
          )}

          {attentionOnly && attentionCount === 0 && (
            <p className="agw-plug-empty" role="status">
              Nothing needs attention.
            </p>
          )}
        </div>
      </div>
      {menu && <RailMenu menu={menu} onClose={() => setMenu(null)} />}
    </>,
  );
};
