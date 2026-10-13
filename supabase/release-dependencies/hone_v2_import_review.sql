-- Reviewed fingerprints only. Separately review before applying to production.
-- Does not enable a gate, choose an actor, or create V2/V3.
insert into job_revision_private.import_reviews(project_id,label,frozen_hash,snapshot_hash,source_digests) values(
 'c879800a-431f-4170-a793-c6bc5173ddc7','V2',
 'affa428107b007c4ed60100f74dc87451831f2da0db9d904c052a113d60a89a3',
 '1a5dfaadb0789b4aef6165f0df6bf3cf3e0d0c98f02253695dcf0fafcd270e69',
 '{"projects":"127ded187eabeeb79d69c054d71d2fff","cost_sections":"3bae7389dd7e147dc68f6fc165fb53ed","cost_lines":"69b5c12409cd7fad1c36f3e0396ee9f4","items":"1720711050d1a6a3eed6fa79a85892ab","sow_documents":"23db2b530e03351deaa9128ab4db83bf","sow_sections":"df76c1a060928e45f9f04af0f6693760","sow_trade_headings":"d751713988987e9331980363e24189ce","sow_lines":"a5b28ea06ac738424fbad018f940da13","rooms":"0b2b4a4eba1f586e24d6a2efb4829709","measurement_groups":"8714335da39996bb923fa7dcf45376c8","measurements":"a878fd03b473a9f19a9e3e7586b0f44e","item_rooms":"ad5fbd94e7bb2ab4e1986e2ac0108859","item_components":"5d0bd600f3c27a7fd70d3b422bd68f25","variations":"d751713988987e9331980363e24189ce"}'::jsonb
);
