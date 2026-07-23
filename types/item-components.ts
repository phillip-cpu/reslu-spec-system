export interface ItemComponent {
  id: string;
  item_id: string;
  library_item_id: string | null;
  name: string;
  supplier: string | null;
  supplier_email: string | null;
  brand: string | null;
  supplier_item_code: string | null;
  quantity_per_item: number;
  unit: string;
  price_trade: number | null;
  finish: string | null;
  product_url: string | null;
  lead_time_weeks: number | null;
  ordered_at: string | null;
  eta: string | null;
  delivered_at: string | null;
  trade_price_received_at: string | null;
  trade_price_source: string | null;
  sort: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateItemComponentInput {
  library_item_id?: string | null;
  name?: string;
  supplier?: string | null;
  supplier_email?: string | null;
  brand?: string | null;
  supplier_item_code?: string | null;
  quantity_per_item?: number;
  unit?: string;
  price_trade?: number | null;
  finish?: string | null;
  product_url?: string | null;
  lead_time_weeks?: number | null;
}

export interface PatchItemComponentInput {
  name?: string;
  supplier?: string | null;
  supplier_email?: string | null;
  brand?: string | null;
  supplier_item_code?: string | null;
  quantity_per_item?: number;
  unit?: string;
  price_trade?: number | null;
  finish?: string | null;
  product_url?: string | null;
  lead_time_weeks?: number | null;
  ordered_at?: string | null;
  eta?: string | null;
  delivered_at?: string | null;
}

export interface ItemComponentsResponse {
  components: ItemComponent[];
}

export interface ItemComponentMutationResponse {
  component?: ItemComponent;
  parent_price_trade: number | null;
}
