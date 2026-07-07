import type { Schema, Struct } from '@strapi/strapi';

export interface CommonLocalizedText extends Struct.ComponentSchema {
  collectionName: 'components_common_localized_texts';
  info: {
    description: 'Texto corto con versi\u00F3n en espa\u00F1ol e ingl\u00E9s. Usado para descripciones breves, roles y biograf\u00EDas.';
    displayName: 'Texto Biling\u00FCe';
    icon: 'align-left';
    pluralName: 'localized-texts';
    singularName: 'localized-text';
  };
  attributes: {
    text_en: Schema.Attribute.Text;
    text_es: Schema.Attribute.Text & Schema.Attribute.Required;
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
    phone: Schema.Attribute.String;
    website: Schema.Attribute.String;
    whatsapp: Schema.Attribute.String;
  };
}

export interface ContactLinks extends Struct.ComponentSchema {
  collectionName: 'components_contact_links';
  info: {
    description: 'Enlaces y canales de contacto. Usado por organizaciones y miembros del equipo.';
    displayName: 'Enlaces de Contacto';
    icon: 'link';
    pluralName: 'contact-links';
    singularName: 'contact-links';
  };
  attributes: {
    email: Schema.Attribute.String;
    facebook: Schema.Attribute.String;
    instagram: Schema.Attribute.String;
    linkedin: Schema.Attribute.String;
    website: Schema.Attribute.String;
  };
}

export interface ContactSocialLinks extends Struct.ComponentSchema {
  collectionName: 'components_contact_social_links';
  info: {
    description: 'Un canal de red social o contacto (plataforma + identificador + URL). Compartido entre miembros de la comunidad, lugares y organizaciones.';
    displayName: 'Enlace Social';
    icon: 'link';
    pluralName: 'social-links';
    singularName: 'social-link';
  };
  attributes: {
    handle: Schema.Attribute.String;
    platform: Schema.Attribute.Enumeration<
      ['instagram', 'facebook', 'tiktok', 'whatsapp', 'web', 'other']
    > &
      Schema.Attribute.Required &
      Schema.Attribute.DefaultTo<'web'>;
    url: Schema.Attribute.String;
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

export interface DestinationDestinationStory extends Struct.ComponentSchema {
  collectionName: 'components_destination_destination_stories';
  info: {
    description: 'Tarjeta para la secci\u00F3n de destinos (t\u00EDtulo, texto, imagen).';
    displayName: 'Historia de Destino';
    icon: 'book';
    pluralName: 'destination-stories';
    singularName: 'destination-story';
  };
  attributes: {
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    text: Schema.Attribute.Text &
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
    description: 'Coordenadas GPS y nombre del lugar con soporte biling\u00FCe.';
    displayName: 'Ubicaci\u00F3n Geogr\u00E1fica';
    icon: 'map-marker';
    pluralName: 'geo-points';
    singularName: 'geo-point';
  };
  attributes: {
    googleMapsUrl: Schema.Attribute.String;
    lat: Schema.Attribute.Float & Schema.Attribute.Required;
    lng: Schema.Attribute.Float & Schema.Attribute.Required;
    locality: Schema.Attribute.Enumeration<['agua-verde', 'rancho-san-cosme']> &
      Schema.Attribute.DefaultTo<'agua-verde'>;
    name_en: Schema.Attribute.String;
    name_es: Schema.Attribute.String;
  };
}

export interface MapMapSection extends Struct.ComponentSchema {
  collectionName: 'components_map_map_sections';
  info: {
    description: 'Secci\u00F3n del mapa con descripci\u00F3n, bot\u00F3n y URL, imagen de fondo.';
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
    description: Schema.Attribute.Text &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
    image: Schema.Attribute.Media<'images'> & Schema.Attribute.Required;
    title: Schema.Attribute.String &
      Schema.Attribute.Required &
      Schema.Attribute.SetPluginOptions<{
        i18n: {
          localized: true;
        };
      }>;
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

export interface RecommendationVisitInfo extends Struct.ComponentSchema {
  collectionName: 'components_recommendation_visit_infos';
  info: {
    description: 'Recomendaciones y notas \u00FAtiles para visitantes (mejor \u00E9poca, qu\u00E9 llevar, accesibilidad, conectividad).';
    displayName: 'Informaci\u00F3n para Visitantes';
    icon: 'info';
    pluralName: 'visit-infos';
    singularName: 'visit-info';
  };
  attributes: {
    accessibilityNotes_en: Schema.Attribute.Text;
    accessibilityNotes_es: Schema.Attribute.Text;
    bestTime_en: Schema.Attribute.Text;
    bestTime_es: Schema.Attribute.Text;
    bring_en: Schema.Attribute.Text;
    bring_es: Schema.Attribute.Text;
    connectivityNotes_en: Schema.Attribute.Text;
    connectivityNotes_es: Schema.Attribute.Text;
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
    isAlwaysOpen: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    text_en: Schema.Attribute.Text;
    text_es: Schema.Attribute.Text;
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
    label_en: Schema.Attribute.String;
    label_es: Schema.Attribute.String & Schema.Attribute.Required;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'common.localized-text': CommonLocalizedText;
      'contact.contact-info': ContactContactInfo;
      'contact.links': ContactLinks;
      'contact.social-links': ContactSocialLinks;
      'cta.cta-section': CtaCtaSection;
      'destination.destination-story': DestinationDestinationStory;
      'hero.hero-section': HeroHeroSection;
      'highlight.highlight-card': HighlightHighlightCard;
      'location.geo-point': LocationGeoPoint;
      'map.map-section': MapMapSection;
      'product.item': ProductItem;
      'quickfact.quick-fact': QuickfactQuickFact;
      'recommendation.visit-info': RecommendationVisitInfo;
      'schedule.hours': ScheduleHours;
      'section.section-header': SectionSectionHeader;
      'story.story-block': StoryStoryBlock;
      'tag.tag-item': TagTagItem;
    }
  }
}
