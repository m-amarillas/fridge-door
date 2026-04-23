alter table document_chunks
  add constraint document_chunks_document_chunk_idx unique (document_id, chunk_index);
