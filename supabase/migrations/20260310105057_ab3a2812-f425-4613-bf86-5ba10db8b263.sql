INSERT INTO schools (name, postcode, urn, address, local_authority)
VALUES (
  'Dean Valley Community Primary School',
  'SK10 5RE',
  '111350',
  'Bollington, Macclesfield, Cheshire',
  'Cheshire East'
)
ON CONFLICT (urn) DO UPDATE SET name = EXCLUDED.name;