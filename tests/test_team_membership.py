from test_ingest import Fixture


class TeamMembershipTests(Fixture):
    def test_reversed_filename_members_share_history_and_human_notes(self):
        self.archive('0012_0345 - first.zip')
        self.archive('0345_0012 - second.zip')
        detail = self.ingest()
        self.assertEqual(detail['counts']['teams'], 1)
        team = detail['teams'][0]
        self.assertEqual(len(team['versions']), 2)
        note = {'text': 'One human decision for this membership', 'decision': 'pending'}
        self.store.save_note('lab-a', team['id'], note)
        self.assertEqual(self.store.detail('lab-a')['teams'][0]['notes'], note)
        originals = self.store.manifest('lab-a')['versions']
        self.assertEqual({tuple(v['students']) for v in originals}, {('0012', '0345'), ('0345', '0012')})
        self.assertEqual(len({v['id'] for v in originals}), 2)

    def test_reversed_explicit_mapping_has_stable_key_without_normalizing_ids(self):
        self.archive('alpha.zip')
        self.archive('beta.zip')
        self.manifest['teams'] = {'alpha.zip': ['Member_B', 'Member_A'], 'beta.zip': ['Member_A', 'Member_B']}
        detail = self.ingest()
        self.assertEqual(detail['counts']['teams'], 1)
        key = detail['teams'][0]['id']
        self.manifest['teams']['alpha.zip'].reverse()
        self.manifest['teams']['beta.zip'].reverse()
        after = self.ingest()
        self.assertEqual(after['teams'][0]['id'], key)
        self.assertEqual(after['counts']['versions'], 2)
        self.assertEqual(self.store.manifest('lab-a')['versions'][0]['students'], ['Member_A', 'Member_B'])

    def test_leading_zero_member_is_distinct_from_nonzero_spelling(self):
        self.archive('first.zip')
        self.archive('second.zip')
        self.manifest['teams'] = {'first.zip': ['0012', '0345'], 'second.zip': ['12', '0345']}
        self.assertEqual(self.ingest()['counts']['teams'], 2)
