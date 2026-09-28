import type { Schema, Struct } from '@strapi/strapi';

export interface AmenityAmenityItem extends Struct.ComponentSchema {
  collectionName: 'components_amenity_amenity_items';
  info: {
    description: 'Etiqueta y descripci\u00F3n de una amenidad o servicio del lugar.';
    displayName: 'Amenidad del Lugar';
    icon: 'check';
    pluralName: 'amenity-items';
    singularName: 'amenity-item';
  };
  attributes: {
    content: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface CampaignCampaignBlock extends Struct.ComponentSchema {
  collectionName: 'components_campaign_campaign_blocks';
  info: {
    description: 'Bloque de campa\u00F1a o alianza: t\u00EDtulo, descripci\u00F3n, logo y enlace.';
    displayName: 'Bloque de Campa\u00F1a';
    icon: 'bullhorn';
    pluralName: 'campaign-blocks';
    singularName: 'campaign-block';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    linkLabel: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    logo: Schema.Attribute.Media<'images'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    url: Schema.Attribute.String;
  };
}

export interface ContactContactInfo extends Struct.ComponentSchema {
  collectionName: 'components_contact_contact_infos';
  info: {
    description: 'Datos de contacto del lugar (WhatsApp, tel\u00E9fono, email, redes sociales).';
    displayName: 'Informaci\u00F3n de Contacto';
    icon: 'phone';
    pluralName: 'contact-infos';
    singularName: 'contact-info';
  };
  attributes: {
    email: Schema.Attribute.String;
    facebook: Schema.Attribute.String;
    instagram: Schema.Attribute.String;
    phoneCountryCode: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'+52'>;
    phoneNumber: Schema.Attribute.String;
    tiktok: Schema.Attribute.String;
    website: Schema.Attribute.String;
    whatsappCountryCode: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<'+52'>;
    whatsappNumber: Schema.Attribute.String;
  };
}

export interface CtaCtaSection extends Struct.ComponentSchema {
  collectionName: 'components_cta_cta_sections';
  info: {
    description: 'Secci\u00F3n final de llamada a la acci\u00F3n al pie de la p\u00E1gina.';
    displayName: 'Llamada a la Acci\u00F3n (CTA)';
    icon: 'megaphone';
    pluralName: 'cta-sections';
    singularName: 'cta-section';
  };
  attributes: {
    buttonLabel: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    buttonLink: Schema.Attribute.String;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface GuideMilestone extends Struct.ComponentSchema {
  collectionName: 'components_guide_milestones';
  info: {
    description: 'Un elemento de la l\u00EDnea de tiempo hist\u00F3rica (a\u00F1o + descripci\u00F3n).';
    displayName: 'Hito Hist\u00F3rico';
    icon: 'time';
    pluralName: 'milestones';
    singularName: 'milestone';
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    text: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    year: Schema.Attribute.String;
  };
}

export interface GuideProtectedLink extends Struct.ComponentSchema {
  collectionName: 'components_guide_protected_links';
  info: {
    description: 'Informaci\u00F3n sobre un \u00E1rea natural protegida con enlace externo.';
    displayName: '\u00C1rea Natural Protegida';
    icon: 'leaf';
    pluralName: 'protected-links';
    singularName: 'protected-link';
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    linkHref: Schema.Attribute.String;
    linkLabel: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    text: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface GuideTextListItem extends Struct.ComponentSchema {
  collectionName: 'components_guide_text_list_items';
  info: {
    description: 'Elemento gen\u00E9rico de texto repetible para reglas, recomendaciones y consejos.';
    displayName: 'Elemento de Lista de Texto';
    icon: 'list';
    pluralName: 'text-list-items';
    singularName: 'text-list-item';
  };
  pluginOptions: {
    i18n: {
      localized: true;
    };
  };
  attributes: {
    text: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface HeroHeroSection extends Struct.ComponentSchema {
  collectionName: 'components_hero_hero_sections';
  info: {
    description: 'Carrusel principal en la cabecera de la p\u00E1gina con t\u00EDtulo, descripci\u00F3n, bot\u00F3n de llamada a la acci\u00F3n y galer\u00EDa de im\u00E1genes.';
    displayName: 'Secci\u00F3n Hero (Carrusel Principal)';
    icon: 'landscape';
    pluralName: 'hero-sections';
    singularName: 'hero-section';
  };
  attributes: {
    ctaLabel: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    ctaLink: Schema.Attribute.String & Schema.Attribute.DefaultTo<'/sitios'>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    images: Schema.Attribute.Media<'images', true> & Schema.Attribute.Required;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    titleHighlight: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface HighlightHighlightCard extends Struct.ComponentSchema {
  collectionName: 'components_highlight_highlight_cards';
  info: {
    description: 'Tarjeta para la secci\u00F3n de destacados (t\u00EDtulo, descripci\u00F3n, imagen, enlace opcional).';
    displayName: 'Tarjeta Destacada';
    icon: 'star';
    pluralName: 'highlight-cards';
    singularName: 'highlight-card';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    link: Schema.Attribute.String;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface LocationGeoPoint extends Struct.ComponentSchema {
  collectionName: 'components_location_geo_points';
  info: {
    description: 'Coordenadas GPS del lugar. Usa el mapa interactivo para seleccionar la ubicaci\u00F3n.';
    displayName: 'Ubicaci\u00F3n Geogr\u00E1fica';
    icon: 'map-marker';
    pluralName: 'geo-points';
    singularName: 'geo-point';
  };
  attributes: {
    geoPoint: Schema.Attribute.JSON &
      Schema.Attribute.Required &
      Schema.Attribute.CustomField<'plugin::sbp-google-map-field.googleMap'>;
  };
}

export interface MapMapSection extends Struct.ComponentSchema {
  collectionName: 'components_map_map_sections';
  info: {
    description: 'Mapa interactivo de la p\u00E1gina de inicio con t\u00EDtulo, descripci\u00F3n, centro y nivel de zoom configurables.';
    displayName: 'Secci\u00F3n de Mapa';
    icon: 'address';
    pluralName: 'map-sections';
    singularName: 'map-section';
  };
  attributes: {
    buttonLabel: Schema.Attribute.String &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    buttonUrl: Schema.Attribute.String;
    centerPoint: Schema.Attribute.Component<'location.geo-point', false>;
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    image: Schema.Attribute.Media<'images'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    zoom: Schema.Attribute.Integer & Schema.Attribute.DefaultTo<12>;
  };
}

export interface ProductItem extends Struct.ComponentSchema {
  collectionName: 'components_product_items';
  info: {
    description: 'Un producto o servicio estructurado ofrecido por un lugar (nombre + descripci\u00F3n).';
    displayName: 'Producto o Servicio';
    icon: 'shopping-cart';
    pluralName: 'product-items';
    singularName: 'product-item';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    name: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface QuickfactQuickFact extends Struct.ComponentSchema {
  collectionName: 'components_quickfact_quick_facts';
  info: {
    description: 'Dato para la cuadr\u00EDcula bento de datos r\u00E1pidos (t\u00EDtulo, valor, descripci\u00F3n).';
    displayName: 'Dato R\u00E1pido';
    icon: 'information';
    pluralName: 'quick-facts';
    singularName: 'quick-fact';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    value: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface RecommendationRecommendationItem
  extends Struct.ComponentSchema {
  collectionName: 'components_recommendation_recommendation_items';
  info: {
    description: 'Una recomendaci\u00F3n para visitantes: t\u00EDtulo y descripci\u00F3n (mejor \u00E9poca, qu\u00E9 llevar, accesibilidad, conectividad).';
    displayName: 'Recomendaci\u00F3n';
    icon: 'star';
    pluralName: 'recommendation-items';
    singularName: 'recommendation-item';
  };
  attributes: {
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface ScheduleHours extends Struct.ComponentSchema {
  collectionName: 'components_schedule_hours';
  info: {
    description: 'Horario de operaci\u00F3n del lugar, con versi\u00F3n en espa\u00F1ol e ingl\u00E9s.';
    displayName: 'Horario de Atenci\u00F3n';
    icon: 'clock';
    pluralName: 'hours';
    singularName: 'hours';
  };
  attributes: {
    text: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface SectionSectionHeader extends Struct.ComponentSchema {
  collectionName: 'components_section_section_headers';
  info: {
    description: 'Bloque reutilizable de t\u00EDtulo y subt\u00EDtulo para una secci\u00F3n.';
    displayName: 'Encabezado de Secci\u00F3n';
    icon: 'text';
    pluralName: 'section-headers';
    singularName: 'section-header';
  };
  attributes: {
    subtitle: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface StoryStoryBlock extends Struct.ComponentSchema {
  collectionName: 'components_story_story_blocks';
  info: {
    description: 'Un bloque narrativo tem\u00E1tico (origen, oficio, legado). Usado para resaltar las historias humanas detr\u00E1s de un lugar.';
    displayName: 'Bloque de Historia';
    icon: 'book';
    pluralName: 'story-blocks';
    singularName: 'story-block';
  };
  attributes: {
    era: Schema.Attribute.String;
    gallery: Schema.Attribute.Media<'images', true>;
    highlightQuote: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    image: Schema.Attribute.Media<'images'>;
    narrative: Schema.Attribute.RichText &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    storyteller: Schema.Attribute.String;
    theme: Schema.Attribute.Enumeration<
      ['origin', 'craft', 'legacy', 'sustainability', 'community']
    > &
      Schema.Attribute.DefaultTo<'origin'>;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

export interface TagTagItem extends Struct.ComponentSchema {
  collectionName: 'components_tag_tag_items';
  info: {
    description: 'Etiqueta biling\u00FCe reutilizable (usada para tags, amenidades y listas similares).';
    displayName: 'Etiqueta';
    icon: 'tag';
    pluralName: 'tag-items';
    singularName: 'tag-item';
  };
  attributes: {
    label: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'amenity.amenity-item': AmenityAmenityItem;
      'campaign.campaign-block': CampaignCampaignBlock;
      'contact.contact-info': ContactContactInfo;
      'cta.cta-section': CtaCtaSection;
      'guide.milestone': GuideMilestone;
      'guide.protected-link': GuideProtectedLink;
      'guide.text-list-item': GuideTextListItem;
      'hero.hero-section': HeroHeroSection;
      'highlight.highlight-card': HighlightHighlightCard;
      'location.geo-point': LocationGeoPoint;
      'map.map-section': MapMapSection;
      'product.item': ProductItem;
      'quickfact.quick-fact': QuickfactQuickFact;
      'recommendation.recommendation-item': RecommendationRecommendationItem;
      'schedule.hours': ScheduleHours;
      'section.section-header': SectionSectionHeader;
      'story.story-block': StoryStoryBlock;
      'tag.tag-item': TagTagItem;
    }
  }
}
