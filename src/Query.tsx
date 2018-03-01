import * as React from 'react';
import ApolloClient, {
  ObservableQuery,
  ApolloError,
  FetchPolicy,
  ErrorPolicy,
  ApolloQueryResult,
  NetworkStatus,
} from 'apollo-client';
import { DocumentNode } from 'graphql';
import { ZenObservable } from 'zen-observable-ts';
import { OperationVariables, GraphqlQueryControls } from './types';
import { parser, DocumentType, IDocumentDefinition } from './parser';
import { ApolloConsumer as Consumer } from './Context';

const shallowEqual = require('fbjs/lib/shallowEqual');
const invariant = require('invariant');

// Improved FetchMoreOptions type, need to port them back to Apollo Client
export interface FetchMoreOptions<TData, TVariables> {
  updateQuery: (
    previousQueryResult: TData,
    options: {
      fetchMoreResult?: TData;
      variables: TVariables;
    },
  ) => TData;
}

// Improved FetchMoreQueryOptions type, need to port them back to Apollo Client
export interface FetchMoreQueryOptions<TVariables, K extends keyof TVariables> {
  variables: Pick<TVariables, K>;
}

// XXX open types improvement PR to AC
// Improved ObservableQuery field types, need to port them back to Apollo Client
export type ObservableQueryFields<TData, TVariables> = Pick<
  ObservableQuery<TData>,
  'startPolling' | 'stopPolling' | 'subscribeToMore'
> & {
  variables: TVariables;
  refetch: (variables?: TVariables) => Promise<ApolloQueryResult<TData>>;
  fetchMore: (<K extends keyof TVariables>(
    fetchMoreOptions: FetchMoreQueryOptions<TVariables, K> & FetchMoreOptions<TData, TVariables>,
  ) => Promise<ApolloQueryResult<TData>>) &
    (<TData2, TVariables2, K extends keyof TVariables2>(
      fetchMoreOptions: { query: DocumentNode } & FetchMoreQueryOptions<TVariables2, K> &
        FetchMoreOptions<TData2, TVariables2>,
    ) => Promise<ApolloQueryResult<TData2>>);
  updateQuery: (
    mapFn: (previousQueryResult: TData, options: { variables?: TVariables }) => TData,
  ) => void;
};

function compact(obj: any) {
  return Object.keys(obj).reduce(
    (acc, key) => {
      if (obj[key] !== undefined) acc[key] = obj[key];
      return acc;
    },
    {} as any,
  );
}

function observableQueryFields<TData, TVariables>(
  observable: ObservableQuery<TData>,
): ObservableQueryFields<TData, TVariables> {
  const fields = {
    variables: observable.variables,
    refetch: observable.refetch.bind(observable),
    fetchMore: observable.fetchMore.bind(observable),
    updateQuery: observable.updateQuery.bind(observable),
    startPolling: observable.startPolling.bind(observable),
    stopPolling: observable.stopPolling.bind(observable),
    subscribeToMore: observable.subscribeToMore.bind(observable),
  };
  // TODO: Need to cast this because we improved the type of `updateQuery` to be parametric
  // on variables, while the type in Apollo client just has object.
  // Consider removing this when that is properly typed
  return fields as ObservableQueryFields<TData, TVariables>;
}

export interface QueryResult<TData = any, TVariables = OperationVariables>
  extends ObservableQueryFields<TData, TVariables> {
  client: ApolloClient<any>;
  data: TData | undefined;
  error?: ApolloError;
  loading: boolean;
  networkStatus: NetworkStatus;
}

export interface QueryProps<TData = any, TVariables = OperationVariables> {
  children: (result: QueryResult<TData, TVariables>) => React.ReactNode;
  fetchPolicy?: FetchPolicy;
  errorPolicy?: ErrorPolicy;
  notifyOnNetworkStatusChange?: boolean;
  pollInterval?: number;
  query: DocumentNode;
  variables?: TVariables;
  ssr?: boolean;
  displayName?: string;
  skip?: boolean;
  client?: ApolloClient<Object>;
}

class Query<TData = any, TVariables = OperationVariables> extends React.Component<
  QueryProps<TData, TVariables>
> {
  private client: ApolloClient<Object>;

  // request / action storage. Note that we delete querySubscription if we
  // unsubscribe but never delete queryObservable once it is created. We
  // only delete queryObservable when we unmount the component.
  private queryObservable: ObservableQuery<TData> | null;
  private querySubscription: ZenObservable.Subscription;
  private previousData: any = {};
  private refetcherQueue: {
    args: any;
    resolve: (value?: any | PromiseLike<any>) => void;
    reject: (reason?: any) => void;
  };

  private hasMounted: boolean;
  private operation: IDocumentDefinition;

  constructor(props: QueryProps<TData, TVariables>) {
    super(props);
    this.initializeQueryObservable(props);
  }

  // For server-side rendering (see getDataFromTree.ts)
  fetchData(): Promise<ApolloQueryResult<any>> | boolean {
    if (this.props.skip) return false;
    // pull off react options
    const { children, ssr, displayName, skip, client, ...opts } = this.props;

    let { fetchPolicy } = opts;
    if (ssr === false) return false;
    if (fetchPolicy === 'network-only' || fetchPolicy === 'cache-and-network') {
      fetchPolicy = 'cache-first'; // ignore force fetch in SSR;
    }

    const observable = this.props.client.watchQuery({
      ...opts,
      fetchPolicy,
    });
    const result = this.queryObservable!.currentResult();

    return result.loading ? observable.result() : false;
  }

  componentDidMount() {
    this.hasMounted = true;
    if (this.props.skip) return;
    this.startQuerySubscription();
    if (this.refetcherQueue) {
      const { args, resolve, reject } = this.refetcherQueue;
      this.queryObservable!.refetch(args)
        .then(resolve)
        .catch(reject);
    }
  }

  componentWillReceiveProps(nextProps: QueryProps<TData, TVariables>) {
    // the next render wants to skip
    if (nextProps.skip && !this.props.skip) {
      this.removeQuerySubscription();
      return;
    }

    if (shallowEqual(this.props, nextProps)) return;

    if (this.props.client !== nextProps.client) {
      this.removeQuerySubscription();
      this.queryObservable = null;
      this.previousData = {};

      this.updateQuery(nextProps);
    }
    if (this.props.query !== nextProps.query) {
      this.removeQuerySubscription();
    }

    this.updateQuery(nextProps);
    if (nextProps.skip) return;
    this.startQuerySubscription();
  }

  componentDidUpdate(prevProps: QueryProps<TData, TVariables>) {
    // // if we changed from not skipping, to now skipping, remove the subscription
    // if (this.props.skip && !prevProps.skip) {
    //   this.removeQuerySubscription();
    //   return;
    // }
    // // if props are equal and we haven't changed client, we are done
    // const { client } = this.props;
    // if (shallowEqual(this.props, prevProps) && this.client === client) {
    //   return;
    // }
    // // new client either from context update or props change
    // // if (this.client !== client && client) {
    // //   this.client = client!;
    // //   this.removeQuerySubscription();
    // //   this.queryObservable = null;
    // //   this.previousData = {};
    // //   this.updateQuery(this.props);
    // // }
    // // if we have a new operation, remove the old one
    // if (this.props.query !== prevProps.query) {
    //   this.removeQuerySubscription();
    // }
    // this.updateQuery(this.props);
    // if (this.props.skip) return;
    // this.startQuerySubscription();
  }

  componentWillUnmount() {
    this.removeQuerySubscription();
    this.hasMounted = false;
  }

  render() {
    const { children } = this.props;
    const queryResult = this.getQueryResult();
    return children(queryResult);
  }

  private extractOptsFromProps(props: QueryProps<TData, TVariables>) {
    const {
      variables,
      pollInterval,
      fetchPolicy,
      errorPolicy,
      notifyOnNetworkStatusChange,
      query,
      displayName = 'Query',
    } = props;

    this.operation = parser(query);

    invariant(
      this.operation.type === DocumentType.Query,
      `The <Query /> component requires a graphql query, but got a ${
        this.operation.type === DocumentType.Mutation ? 'mutation' : 'subscription'
      }.`,
    );

    return compact({
      variables,
      pollInterval,
      query,
      fetchPolicy,
      errorPolicy,
      notifyOnNetworkStatusChange,
      metadata: { reactComponent: { displayName } },
    });
  }

  private initializeQueryObservable(props: QueryProps<TData, TVariables>) {
    const opts = this.extractOptsFromProps(props);
    this.queryObservable = props.client.watchQuery(opts);
  }

  private updateQuery(props: QueryProps<TData, TVariables>) {
    // if we skipped initially, we may not have yet created the observable
    if (!this.queryObservable) this.initializeQueryObservable(props);

    this.queryObservable!.setOptions(this.extractOptsFromProps(props))
      // The error will be passed to the child container, so we don't
      // need to log it here. We could conceivably log something if
      // an option was set. OTOH we don't log errors w/ the original
      // query. See https://github.com/apollostack/react-apollo/issues/404
      .catch(() => null);
  }

  private startQuerySubscription = () => {
    if (this.querySubscription) return;
    this.querySubscription = this.queryObservable!.subscribe({
      next: this.updateCurrentData,
      error: error => {
        this.resubscribeToQuery();
        // Quick fix for https://github.com/apollostack/react-apollo/issues/378
        if (!error.hasOwnProperty('graphQLErrors')) throw error;

        this.updateCurrentData();
      },
    });
  };

  private removeQuerySubscription = () => {
    if (this.querySubscription) {
      this.querySubscription.unsubscribe();
      delete this.querySubscription;
    }
  };

  private resubscribeToQuery() {
    this.removeQuerySubscription();

    const lastError = this.queryObservable!.getLastError();
    const lastResult = this.queryObservable!.getLastResult();
    // If lastError is set, the observable will immediately
    // send it, causing the stream to terminate on initialization.
    // We clear everything here and restore it afterward to
    // make sure the new subscription sticks.
    this.queryObservable!.resetLastResults();
    this.startQuerySubscription();
    Object.assign(this.queryObservable!, { lastError, lastResult });
  }

  private updateCurrentData = () => {
    // force a rerender that goes through shouldComponentUpdate
    if (this.hasMounted) this.forceUpdate();
  };

  private getQueryResult = (): QueryResult<TData, TVariables> => {
    let data = { data: Object.create(null) as TData } as any;
    // attach bound methods
    Object.assign(data, observableQueryFields(this.queryObservable!));
    // fetch the current result (if any) from the store
    const currentResult = this.queryObservable!.currentResult();
    const { loading, networkStatus, errors } = currentResult;
    let { error } = currentResult;
    // until a set naming convention for networkError and graphQLErrors is decided upon, we map errors (graphQLErrors) to the error props
    if (errors && errors.length > 0) {
      error = new ApolloError({ graphQLErrors: errors });
    }

    Object.assign(data, { loading, networkStatus, error });

    if (loading) {
      Object.assign(data.data, this.previousData, currentResult.data);
    } else if (error) {
      Object.assign(data, {
        data: (this.queryObservable!.getLastResult() || {}).data,
      });
    } else {
      Object.assign(data.data, currentResult.data);
      this.previousData = currentResult.data;
    }
    // handle race condition where refetch is called on child mount
    if (!this.querySubscription) {
      (data as GraphqlQueryControls).refetch = args => {
        return new Promise((r, f) => {
          this.refetcherQueue = { resolve: r, reject: f, args };
        });
      };
    }

    data.client = this.props.client;

    return data;
  };
}

export default class ApolloQuery extends React.Component {
  render() {
    return <Consumer>{client => <Query client={client} {...this.props} />}</Consumer>;
  }
}
