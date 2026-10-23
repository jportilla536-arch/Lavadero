import type { CreateSurveyPayload } from './types';

export interface OrderSurveyContext {
  orderId: string;
  orderNumber: string;
  businessName?: string;
  customerName?: string;
  vehiclePlate?: string;
  vehicleType?: string;
  servicesSummary?: string;
}

/**
 * Construye una encuesta B2B altamente optimizada para el sector de Lavadero / Car Wash.
 */
export function buildCarWashSurveyPayload(
  ctx: OrderSurveyContext,
): CreateSurveyPayload {
  const business = ctx.businessName || 'nuestro Lavadero';
  const plateText = ctx.vehiclePlate ? ` (${ctx.vehiclePlate.toUpperCase()})` : '';

  return {
    title: `Encuesta de Calidad — Orden #${ctx.orderNumber}${plateText}`,
    description: `Hola ${ctx.customerName || 'estimado cliente'}, en ${business} nos esforzamos por ofrecerte el mejor cuidado para tu vehículo. Tu opinión nos ayuda a mantener la máxima calidad.`,
    publishImmediately: true,
    settings: {
      themePrimaryColor: '#0284c7',
      themeBackgroundColor: '#f8fafc',
      allowAnonymous: false,
    },
    questions: [
      {
        title: '¿Cómo calificarías la calidad del lavado, limpieza y acabado exterior/interior?',
        type: 'RATING_STARS',
        required: true,
        config: {
          minValue: 1,
          maxValue: 5,
        },
      },
      {
        title: '¿Cómo calificarías el tiempo de espera y la puntualidad en la entrega?',
        type: 'RATING_STARS',
        required: true,
        config: {
          minValue: 1,
          maxValue: 5,
        },
      },
      {
        title: `¿Qué probabilidad hay de que recomiendes ${business} a un amigo o colega?`,
        type: 'NPS_SCALE',
        required: true,
        config: {
          minValue: 0,
          maxValue: 10,
          lowLabel: 'Nada probable',
          highLabel: 'Totalmente probable',
        },
      },
      {
        title: '¿Cuál fue el aspecto más destacado de nuestro servicio?',
        type: 'SINGLE_CHOICE',
        required: true,
        options: [
          { label: 'Limpieza profunda y brillo', value: 'calidad' },
          { label: 'Rapidez y eficiencia del personal', value: 'rapidez' },
          { label: 'Atención al cliente y cordialidad', value: 'atencion' },
          { label: 'Relación calidad / precio justo', value: 'precio' },
        ],
      },
      {
        title: '¿Qué áreas consideras que podemos mejorar para tu próxima visita?',
        type: 'MULTIPLE_CHOICE',
        required: false,
        options: [
          { label: 'Tiempo de espera en horas pico', value: 'tiempos' },
          { label: 'Detallado en llantas, rines o vidrios', value: 'detallado' },
          { label: 'Comodidad en sala de espera', value: 'sala' },
          { label: 'Disponibilidad de métodos de pago', value: 'pagos' },
        ],
      },
      {
        title: 'Comentarios adicionales, sugerencias o mensaje para el equipo',
        type: 'PARAGRAPH',
        required: false,
      },
    ],
  };
}
