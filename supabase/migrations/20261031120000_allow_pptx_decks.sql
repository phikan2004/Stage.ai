-- Presentations can now be PowerPoint files as well as PDFs, stored as they were uploaded.
-- decks.pdf_path and decks.pdf_hash keep their names and now hold the path and hash of either kind of file.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    update storage.buckets
    set allowed_mime_types = array[
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg'
    ]
    where id = 'producer-decks';
  end if;
end $$;
