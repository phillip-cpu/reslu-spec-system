-- ============================================================
-- RESLU Spec System — Address Book seed data
-- Parsed from docs-address-book-export.txt (pdftotext of RESLU's
-- Monday.com address book export, 5 July 2026) by
-- scripts_parse_address_book.py — see that script's docstring for
-- the exact parsing rules (blank-line handling, wrapped URL/email
-- continuation lines, deduped repeated emails, category heading
-- normalisation e.g. 'CARPENTERS' -> 'Carpenters').
--
-- Run AFTER migrations/013_boards_contacts.sql has been applied.
-- Idempotent guard: skips a row if a contact with the same
-- (company, category) already exists and is not deleted, so this
-- file can be safely re-run.
--
-- 109 companies parsed. Rows flagged 'Imported — verify'
-- in the notes column have some parsing ambiguity — a human should
-- confirm them against the original Monday board.
-- ============================================================

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Harvey Norman Commercial', 'Sarah Adams', '0881508000', 'Sarah.Adams@au.harveynorman.com', 'harveynormancommercial.com.au', NULL, 'Appliances', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Harvey Norman Commercial'
      and c.category is not distinct from 'Appliances'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Designer Appliances', 'Cushla', NULL, 'cushla@theaag.com.au', NULL, NULL, 'Appliances', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Designer Appliances'
      and c.category is not distinct from 'Appliances'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Demor', 'Briony Collins', NULL, 'Briony@demor.com.au', NULL, 'Tapware & Sanitaryware', 'Appliances', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Demor'
      and c.category is not distinct from 'Appliances'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Artedomus', 'Katie Farrall', NULL, 'katie@artedomus.com', 'artedomus.com', NULL, 'Appliances', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Artedomus'
      and c.category is not distinct from 'Appliances'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'LA Custom Joinery', 'Steve Coley (Quoting)', NULL, 'steve@lacustomjoinery.com.au', 'lacustomjoinery.com.au', NULL, 'Appliances', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'LA Custom Joinery'
      and c.category is not distinct from 'Appliances'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Atelier 18 Designs', 'Vishal Maraviya', '0499515954', 'designs@atelier18.com.au', NULL, NULL, 'Architect', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Atelier 18 Designs'
      and c.category is not distinct from 'Architect'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'S.A Singer Service', 'Stephen', '0407988460', 'stephen@sasinger.com', 'www.sasingerservices.com', 'Joinery, Second fix', 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'S.A Singer Service'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Michael Patruno', 'Michael', NULL, 'truni3@hotmail.com', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Michael Patruno'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Andrew Seeley', 'Andrew', '0405199655', 'andrewseeleycarpenter@gmail.com', NULL, 'Decks , Pergolas', 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Andrew Seeley'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Crouch Constructions', 'Sam Crouch', '0439862456', 'sam@crouchconstructions.com.au', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Crouch Constructions'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Goodwood Timber', 'Michael', '0882717211', 'sales@goodwoodtimber.com.au', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Goodwood Timber'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Hi Crete - Roofing & Walling', 'Sam', '0431223987', 'sam@hicreteroofing.com.au', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Hi Crete - Roofing & Walling'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Asurco Roofing & Cladding', NULL, '0428454811', 'pavan.shivaprakash@mcmservices.com.au', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Asurco Roofing & Cladding'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Building Dynamix', 'Michael', '0457338896', 'michael@buildingdynamix.com.au', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Building Dynamix'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Sakar Constructions', 'Darius', '0425788241', 'darius@sakarconstructions.com.au', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Sakar Constructions'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'SA Construct', 'Dylan', '0479005569', 'dylan.g@sculptform.com', NULL, NULL, 'Carpenters', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'SA Construct'
      and c.category is not distinct from 'Carpenters'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Top Caulking', 'Dorian', '0414655727', 'contact@topcaulking.com', 'www.topcaulking.com', NULL, 'Caulking', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Top Caulking'
      and c.category is not distinct from 'Caulking'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Windsor', 'Phillip McCallum', '64212283943', 'phillip.mccallum@windsorhardware.com.au', 'https://windsorhardware.co.nz/au', NULL, 'Hardware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Windsor'
      and c.category is not distinct from 'Hardware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Handle House', NULL, '0754501440', 'sales@handlehouse.com.au', 'https://handlehouse.com.au/', NULL, 'Hardware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Handle House'
      and c.category is not distinct from 'Hardware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Manovella', NULL, NULL, 'sales@manovelladesign.com', 'https://manovelladesign.com/', NULL, 'Hardware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Manovella'
      and c.category is not distinct from 'Hardware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Made Measure', NULL, '610431489504', 'info@mademeasure.com', 'www.mademeasure.com', NULL, 'Hardware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Made Measure'
      and c.category is not distinct from 'Hardware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Halliday’s', NULL, '0882686477', 'sales@halliday.com.au', 'https://halliday.com.au/', NULL, 'Hardware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Halliday’s'
      and c.category is not distinct from 'Hardware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide Tile Removal', 'Pete', '0424759464', 'info@adelaidetileremoval.com.au', NULL, NULL, 'Demolition', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide Tile Removal'
      and c.category is not distinct from 'Demolition'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Reslu Plastering', 'Nathan', '0408824874', 'nathan@reslu.com.au', NULL, NULL, 'Drywall & Plastering', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Reslu Plastering'
      and c.category is not distinct from 'Drywall & Plastering'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'JOD Electrical', 'Jack O’Donnell', '0417301886', 'jack@jodelectrical.com', 'https://www.jodelectrical.com/', NULL, 'Electrical', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'JOD Electrical'
      and c.category is not distinct from 'Electrical'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Hoile Electrical', 'Blake', '0482099388', 'blake@hoileelectrical.com.au', 'https://www.hoileelectrical.com.au/?utm_source=GBP&utm_medium=organic&utm_campaign=office', NULL, 'Electrical', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Hoile Electrical'
      and c.category is not distinct from 'Electrical'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Clipsal', 'Marcus Reilly', '0419876884', 'Marcus.Reilly@se.com', 'https://www.clipsal.com', NULL, 'Electrical', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Clipsal'
      and c.category is not distinct from 'Electrical'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'FInal Fix', 'Jason', '61419809889', 'jason@finalfixelectrical.com.au', NULL, NULL, 'Electrical', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'FInal Fix'
      and c.category is not distinct from 'Electrical'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Coast & Country Electrical', NULL, '0457923337', 'admin@coastalandcountryelectrical.com.au', NULL, NULL, 'Electrical', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Coast & Country Electrical'
      and c.category is not distinct from 'Electrical'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'AJAX Engineering Civil & Structural', 'John Aquilina', '0406304865', 'j.aquilina@ajaxeng.com', 'https://ajaxeng.com/', 'Footings', 'Engineering', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'AJAX Engineering Civil & Structural'
      and c.category is not distinct from 'Engineering'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'T&B Estimating', 'Tom Vardon', '0411776590', 'tbe96@bigpond.com', NULL, 'Timber Truss', 'Engineering', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'T&B Estimating'
      and c.category is not distinct from 'Engineering'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'CSC - Chris Schmidt Consulting', 'Chris Schmidt', '0411754849', 'chris@cs-consult.com.au', NULL, 'Structural, stormwater', 'Engineering', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'CSC - Chris Schmidt Consulting'
      and c.category is not distinct from 'Engineering'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Solid Finish Construction', 'Michael Bruno', '0411454407', 'solid.enquiries@outlook.com', NULL, NULL, 'Foundations', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Solid Finish Construction'
      and c.category is not distinct from 'Foundations'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Carpet Court', 'Bill Fuller', '82851999', 'bill.parafieldcc@outlook.com', NULL, NULL, 'Flooring', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Carpet Court'
      and c.category is not distinct from 'Flooring'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Nedesa Flooring', 'Ned', '0414649161', 'info@nedesa.com.au', 'http://www.nedesaflooring.com.au/', NULL, 'Flooring', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Nedesa Flooring'
      and c.category is not distinct from 'Flooring'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Bremworth', 'Kylie Crawford', '0461308347', 'kcrawford@bremworth.com.au', NULL, NULL, 'Flooring', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Bremworth'
      and c.category is not distinct from 'Flooring'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Terrace Floors', 'Katie Lawson', '0466180200', 'katiel@terracefloors.com.au', 'https://terracefloors.com.au/contact?srsltid=AfmBOopBLzwg_M9wXOALQOtZgcWKappBJwhOgVTE70nmHzGubVBj4FSn', NULL, 'Flooring', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Terrace Floors'
      and c.category is not distinct from 'Flooring'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Velo Epoxy Flooring', NULL, '0401685099', NULL, NULL, NULL, 'Flooring', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Velo Epoxy Flooring'
      and c.category is not distinct from 'Flooring'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Epoxy Flooring Adelaide', NULL, '0421499576', NULL, NULL, NULL, 'Flooring', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Epoxy Flooring Adelaide'
      and c.category is not distinct from 'Flooring'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Tom Dixon', 'Maria Mantovan', '0413671995', 'maria@australianoffice.com.au', 'https://www.tomdixon.net/en/', NULL, 'Furniture', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Tom Dixon'
      and c.category is not distinct from 'Furniture'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'King Trade & Commercial', 'Steven Leitch', NULL, 'steven.leitch@kingliving.com.au', 'https://www.kingliving.com.au/king-trade-and-commercial', NULL, 'Furniture', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'King Trade & Commercial'
      and c.category is not distinct from 'Furniture'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Horgans', 'Marcus Morey', '0481370145', 'marcus@horgans.com.au', 'https://horgans.com.au', NULL, 'Furniture', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Horgans'
      and c.category is not distinct from 'Furniture'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Space Furniture', 'Ali Chainey', '0419625732', 'Alic@spacefurniture.com.au', 'https://www.spacefurniture.com.au', NULL, 'Furniture', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Space Furniture'
      and c.category is not distinct from 'Furniture'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Stylecraft Furniture', 'Stephanie Candelli', '0413589438', 'stephaniec@stylecraft.com.au', 'https://stylecraft.com.au', NULL, 'Furniture', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Stylecraft Furniture'
      and c.category is not distinct from 'Furniture'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Elegance Glass & Aluminium', 'Thomas Hetherington', '0431226993', 'info@eleganceglass.com.au', NULL, NULL, 'Glazier', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Elegance Glass & Aluminium'
      and c.category is not distinct from 'Glazier'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'JAAT Inspirations', 'Allan', '61403773434', 'jaatinspirations@bigpond.com', NULL, NULL, 'Glazier', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'JAAT Inspirations'
      and c.category is not distinct from 'Glazier'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Alpha Panelli', 'Dario / Bianca', '61450715515', 'admin@alphapanelli.com.au', 'http://www.alphapanelli.com.au/', 'Supply only', 'Joinery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Alpha Panelli'
      and c.category is not distinct from 'Joinery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Smart Cabinets', 'Moshtaq Hussein', '0447075499', 'moshtaq0011@gmail.com', NULL, 'Install Only', 'Joinery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Smart Cabinets'
      and c.category is not distinct from 'Joinery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'LA Custom Joinery', 'Vincent Laidin', '82589998', 'vincent@lacustomjoinery.com.au', NULL, 'Supply & Install', 'Joinery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'LA Custom Joinery'
      and c.category is not distinct from 'Joinery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Unique Spaces', NULL, '0882624050', 'jon@uniquespace.co', NULL, NULL, 'Joinery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Unique Spaces'
      and c.category is not distinct from 'Joinery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Jag Kichens', 'Penny or Jim', '0870080917', 'info@jagkitchens.com.au', NULL, NULL, 'Joinery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Jag Kichens'
      and c.category is not distinct from 'Joinery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'P&G Furnishing', 'Michael', '0883820744', 'info@sasolid.com.au', NULL, 'Supply & Install', 'Joinery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'P&G Furnishing'
      and c.category is not distinct from 'Joinery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Maison Design', 'Annette Petrenko', '0883639266', 'annette@maisondesign.com.au', 'http://www.maisondesign.com.au/', NULL, 'Landscaping', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Maison Design'
      and c.category is not distinct from 'Landscaping'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Eco Outdoor', 'Steve Liggett', '0427299726', 'steve.l@ecooutdoor.com.au', NULL, NULL, 'Landscaping', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Eco Outdoor'
      and c.category is not distinct from 'Landscaping'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Garden Habitats', 'Tim', '0478495085', 'tcfigueira@gmail.com', NULL, NULL, 'Landscaping', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Garden Habitats'
      and c.category is not distinct from 'Landscaping'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'KODA Lighting', NULL, NULL, 'hello@kodalighting.com.au', 'https://www.kodalighting.com/', NULL, 'Lighting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'KODA Lighting'
      and c.category is not distinct from 'Lighting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'BEACON Lighting - Churchill', NULL, '0407730047', 'ChurchillTrade@beaconlighting.com.au', 'https://www.beaconlighting.com.au/storelocator/beacon-lightinggepps-cross/?srsltid=AfmBOoqvlCKOJu4DVS00VDrCGhLHI9NaARgEp6_E8IxHI9mlhmmYrZ-', NULL, 'Lighting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'BEACON Lighting - Churchill'
      and c.category is not distinct from 'Lighting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'ABOUT SPACE', NULL, NULL, 'sales@aboutspace.net.au', 'https://www.aboutspace.net.au', NULL, 'Lighting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'ABOUT SPACE'
      and c.category is not distinct from 'Lighting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'EST Lighting', 'Isabella', '61386390521', 'hello@estlighting.com.au', NULL, NULL, 'Lighting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'EST Lighting'
      and c.category is not distinct from 'Lighting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Will Young Painting', 'Will Young', '0458510447', 'Wilyoungpainting@outlook.com', NULL, NULL, 'Painting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Will Young Painting'
      and c.category is not distinct from 'Painting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Colourfast Coatings', 'Daniel', '0422759235', NULL, NULL, NULL, 'Painting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Colourfast Coatings'
      and c.category is not distinct from 'Painting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide Wallpaper Professionals', 'Connor', '0421384339', 'conor@profilms.com.au', NULL, NULL, 'Painting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide Wallpaper Professionals'
      and c.category is not distinct from 'Painting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide Painting services', 'Ricky', '0418111507', NULL, NULL, NULL, 'Painting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide Painting services'
      and c.category is not distinct from 'Painting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Beaumont Painting', NULL, '0458733388', 'admin@beaumontpainting.com.au', NULL, NULL, 'Painting', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Beaumont Painting'
      and c.category is not distinct from 'Painting'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Cameron Davidson Painting', '82957827', '1800431833', 'cdpainters@bigpond.com', NULL, NULL, 'Painting', 'Imported — verify'
  where not exists (
    select 1 from contacts c
    where c.company = 'Cameron Davidson Painting'
      and c.category is not distinct from 'Painting'
      and c.deleted_at is null
  );  -- flags: contact-name-looks-like-phone

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Zamp Plumbing', 'Andrew', '0421770275', 'admin@zampplumbing.com', NULL, NULL, 'Plumbing', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Zamp Plumbing'
      and c.category is not distinct from 'Plumbing'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide West PG', 'Hayden', '0433394352', 'adelaidewestpg@outlook.com', NULL, NULL, 'Plumbing', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide West PG'
      and c.category is not distinct from 'Plumbing'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Monster Plumbing & Gas', NULL, '0431749293', NULL, 'https://monstergasplumbing.com.au/', NULL, 'Plumbing', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Monster Plumbing & Gas'
      and c.category is not distinct from 'Plumbing'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide Signature Plumbing', NULL, '0456157967', 'adlsignatureplumbing@gmail.com', NULL, NULL, 'Plumbing', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide Signature Plumbing'
      and c.category is not distinct from 'Plumbing'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Shoreline Plumbing & Gas', NULL, '0494048874', 'Shoreline.plumbing@outlook.com', NULL, NULL, 'Plumbing', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Shoreline Plumbing & Gas'
      and c.category is not distinct from 'Plumbing'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Lowes Rendering', 'Dylan Lowe', '0431020723', 'lowesrendering@outlook.com', 'https://lowesrendering.com.au/', NULL, 'Rendering', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Lowes Rendering'
      and c.category is not distinct from 'Rendering'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide pro renderer', 'Shane gordon', '0421730764', NULL, NULL, NULL, 'Rendering', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide pro renderer'
      and c.category is not distinct from 'Rendering'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide pro renderer', 'Kane Manning', '0421732778', NULL, NULL, NULL, 'Rendering', 'Imported — verify'
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide pro renderer'
      and c.category is not distinct from 'Rendering'
      and c.deleted_at is null
  );  -- flags: dup-in-source

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'The Source', 'Tania Vanikiotis', '83622282', 'info@the-source.com.au', 'https://the-source.com.au/', NULL, 'Sanitary Ware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'The Source'
      and c.category is not distinct from 'Sanitary Ware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'ABI Interiors', NULL, NULL, NULL, 'www.abiinteriors.com.au', NULL, 'Sanitary Ware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'ABI Interiors'
      and c.category is not distinct from 'Sanitary Ware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Buildmat', NULL, NULL, 'sales@buildmat.com.au', 'https://www.buildmat.com.au/', NULL, 'Sanitary Ware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Buildmat'
      and c.category is not distinct from 'Sanitary Ware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Yabby', NULL, '0258504705', 'hello@yabby.com.au', NULL, NULL, 'Sanitary Ware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Yabby'
      and c.category is not distinct from 'Sanitary Ware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Tradelink Hilton', NULL, '0881937960', 'shilpa.lakhotia@tradelink.com.au', NULL, NULL, 'Sanitary Ware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Tradelink Hilton'
      and c.category is not distinct from 'Sanitary Ware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Routley', 'Tony Ball', '61408837887', 'tony@routleysonline.com.au', NULL, NULL, 'Sanitary Ware', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Routley'
      and c.category is not distinct from 'Sanitary Ware'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Signorino', 'Liz', '0487777372', 'liz@signorino.com.au', 'https://www.signorino.com.au/', NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Signorino'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Forma', 'Lenice (Accounts & Admin) / Dom (Scheduling) / Jake (Quoting & Sales)', '+61870070950', 'lenice.v@forma.com.au', 'forma.com.au', 'Stone & Glass', 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Forma'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Stone Ambassador', NULL, '0884230150', NULL, 'https://www.stoneambassador.com.au/', NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Stone Ambassador'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Caesarstone', 'Tania', '0484011767', 'tania.zito@caesarstone.com.au', 'https://www.caesarstone.com.au', NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Caesarstone'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Unique Stone', NULL, '82662280', 'estimating@uniqstone.com.au', NULL, NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Unique Stone'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Stone Shield Surface Solution', 'Loui', '61476243802', 'inf0@stonshieldsurfacesolution.com.au', NULL, NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Stone Shield Surface Solution'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'stoneshie', 'Loui', '610476243802', 'info@stoneshieldsurfacesolutions.com.au', NULL, NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'stoneshie'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'CDK Stone', 'Jess', '0883402877', 'adelaide@cdkstone.com.au', 'https://www.cdkstone.com.au', NULL, 'Stone', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'CDK Stone'
      and c.category is not distinct from 'Stone'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Materialised', 'Bronwyn Randall-Smith', '0400668066', 'bronwyn.randall-smith@materialised.com', 'https://materialised.com.au/', NULL, 'Textiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Materialised'
      and c.category is not distinct from 'Textiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Art Hide', 'Kura Perkins', '0458785361', 'kura@arthide.co', 'https://ahgcshowroom.com.au/', NULL, 'Textiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Art Hide'
      and c.category is not distinct from 'Textiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'James Dunlop/Mokum Textiles', NULL, '0883328372', 'sasales@mokumtextiles.com', 'https://www.jamesdunloptextiles.com/', NULL, 'Textiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'James Dunlop/Mokum Textiles'
      and c.category is not distinct from 'Textiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Ridgewood Timber', 'Jason Hammond', '61883411822', 'jason@ridgewoodtimber.com', 'https://ridgewoodtimber.com/', NULL, 'Timber', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Ridgewood Timber'
      and c.category is not distinct from 'Timber'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Coastal Waste', 'Nicole Deluca', NULL, 'admin@coastalwastebins.com.au', 'https://coastalwastebins.com.au/', NULL, 'Waste', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Coastal Waste'
      and c.category is not distinct from 'Waste'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Jims Skips', 'Will', '0409899943', NULL, NULL, NULL, 'Waste', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Jims Skips'
      and c.category is not distinct from 'Waste'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Deejay’s Skips', NULL, '0870840074', NULL, 'https://dejayskips.com.au', NULL, 'Waste', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Deejay’s Skips'
      and c.category is not distinct from 'Waste'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Perini', 'Pamela. 03 94210550', NULL, 'info@perini.com.au', NULL, NULL, 'Tiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Perini'
      and c.category is not distinct from 'Tiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide Bespoke Tiling', 'Martin Williams', '0402608033', 'Info@adelaidebespoketiling.com.au', NULL, NULL, 'Tiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide Bespoke Tiling'
      and c.category is not distinct from 'Tiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Ceramica Living', 'Peter', '0451533556', 'peter@ceramicaliving.com.au', NULL, NULL, 'Tiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Ceramica Living'
      and c.category is not distinct from 'Tiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Peter Capurso', 'Peter', '0409848120', 'Peter.Capurso@hotmail.com', NULL, 'Bathrooms', 'Tiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Peter Capurso'
      and c.category is not distinct from 'Tiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Porcelan Plus Australia', 'Colin', '61406198948', 'Colin@porcelainplus.com.au', NULL, NULL, 'Tiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Porcelan Plus Australia'
      and c.category is not distinct from 'Tiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Aura Tiling - Nick', 'Nick', NULL, 'aura.tiling@bigpond.com.au', NULL, NULL, 'Tiles', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Aura Tiling - Nick'
      and c.category is not distinct from 'Tiles'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Bizy Concreting', 'Brett Hennessey', '0459137295', 'brett.hennessey@outlook.com', NULL, NULL, 'Concrete', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Bizy Concreting'
      and c.category is not distinct from 'Concrete'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Absolutely Creative', 'Mirjana', '0409280205', 'ac70@bigpond.com', NULL, 'Curtains , Upholstery', 'Upholstery / Drapery', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Absolutely Creative'
      and c.category is not distinct from 'Upholstery / Drapery'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Deco Wood', 'Jamie', '0478350806', 'jamie@deco.net.au', NULL, NULL, 'Metal works', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Deco Wood'
      and c.category is not distinct from 'Metal works'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide classic pools', 'Anna Gorpynyak', '82933067', 'info@adelaideclassicpools.com.au', NULL, NULL, 'Pools and spas', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide classic pools'
      and c.category is not distinct from 'Pools and spas'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Complete Concrete pools', NULL, '81204162', 'info@concretepoolsadelaide.com', NULL, NULL, 'Pools and spas', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Complete Concrete pools'
      and c.category is not distinct from 'Pools and spas'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'eco crete resurfacing', NULL, '0488693599', 'hello@ecocreteadelaide.com.au', NULL, NULL, 'Pools and spas', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'eco crete resurfacing'
      and c.category is not distinct from 'Pools and spas'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Adelaide pool restorations', NULL, '0412399994', 'andrewzarko27@outlook.com', NULL, NULL, 'Pools and spas', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Adelaide pool restorations'
      and c.category is not distinct from 'Pools and spas'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Alexander Symonds', NULL, '0881301666', 'adelaide@alexander.com.au', NULL, NULL, 'Surveyor', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Alexander Symonds'
      and c.category is not distinct from 'Surveyor'
      and c.deleted_at is null
  );

insert into contacts (company, contact_name, phone, email, website, specialty, category, notes)
  select 'Andrew & Associates', NULL, '0882321954', 'info@andrewandassoc.com.au', NULL, NULL, 'Surveyor', NULL
  where not exists (
    select 1 from contacts c
    where c.company = 'Andrew & Associates'
      and c.category is not distinct from 'Surveyor'
      and c.deleted_at is null
  );
